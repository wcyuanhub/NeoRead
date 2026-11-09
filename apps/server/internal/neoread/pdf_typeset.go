package neoread

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const typesetVersion = "babeldoc-0.6.4-neoread-2"

type pdfTypesetStatus struct {
	Pages                int    `json:"pages,omitempty"`
	Phase                string `json:"phase,omitempty"`
	Status               string `json:"status"`
	Revision             string `json:"revision"`
	Reason               string `json:"reason,omitempty"`
	Translated           int    `json:"translated,omitempty"`
	Preserved            int    `json:"preserved,omitempty"`
	TranslatedCharacters int    `json:"translatedCharacters,omitempty"`
	PreservedCharacters  int    `json:"preservedCharacters,omitempty"`
}
type pdfTypesetBlock struct {
	PDFBlock
	Sentences  []TranslationSentence `json:"sentences"`
	SourceHash string                `json:"sourceHash"`
}
type pdfTypesetSnapshot struct {
	Version    string            `json:"version"`
	DocumentID string            `json:"documentId"`
	Manifest   layoutManifest    `json:"manifest"`
	Blocks     []pdfTypesetBlock `json:"blocks"`
}
type pdfTypesetState struct {
	mu   sync.Mutex
	jobs map[string]pdfTypesetStatus
	lane chan struct{}
}

func (s *Server) typesetSnapshot(documentID string) (pdfTypesetSnapshot, string, error) {
	d, err := s.Store.Document(documentID)
	if err != nil || d.Type != "pdf" {
		return pdfTypesetSnapshot{}, "", errors.New("document_missing")
	}
	m, err := s.readLayout(documentID)
	if err != nil {
		return pdfTypesetSnapshot{}, "", errors.New("parse_pending")
	}
	items, err := s.visibleTranslations(documentID, m)
	if err != nil {
		return pdfTypesetSnapshot{}, "", errors.New("snapshot_failed")
	}
	byID := map[string]TranslationBlock{}
	for _, item := range items {
		byID[item.BlockID] = item
	}
	snapshot := pdfTypesetSnapshot{Version: typesetVersion, DocumentID: d.ID, Manifest: m, Blocks: []pdfTypesetBlock{}}
	for _, block := range m.Blocks {
		item := byID[block.ID]
		if translationSource(block) == "" || item.Status != "complete" || len(item.Sentences) == 0 || item.SourceHash != translationHash(translationSource(block)) {
			continue
		}
		// Figure/table assets include a saved caption translation. Match only
		// that caption; never translate labels inside the figure as its prose.
		block.Text = translationSource(block)
		snapshot.Blocks = append(snapshot.Blocks, pdfTypesetBlock{block, item.Sentences, item.SourceHash})
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return snapshot, "", err
	}
	hash := sha256.Sum256(data)
	return snapshot, hex.EncodeToString(hash[:]), nil
}

func (s *Server) typesetDirectory(documentID, revision string) string {
	return filepath.Join(s.Store.Root, "cache", documentID, "typeset", revision)
}

func typesetRuntime() (root, python, worker string, err error) {
	root = os.Getenv("NEOREAD_BABELDOC")
	var config struct {
		Python  string `json:"python"`
		Version string `json:"version"`
	}
	data, e := os.ReadFile(filepath.Join(root, "runtime.json"))
	if root == "" || e != nil || json.Unmarshal(data, &config) != nil || config.Version != "0.6.4" || config.Python == "" || filepath.IsAbs(config.Python) || !filepath.IsLocal(config.Python) {
		return "", "", "", errors.New("runtime_missing")
	}
	python, worker = filepath.Join(root, config.Python), filepath.Join(root, "worker.py")
	for _, path := range []string{python, worker} {
		if stat, e := os.Stat(path); e != nil || !stat.Mode().IsRegular() {
			return "", "", "", errors.New("runtime_missing")
		}
	}
	return root, python, worker, nil
}

func (s *Server) cachedTypeset(documentID, revision string) (pdfTypesetStatus, bool) {
	var status pdfTypesetStatus
	root := s.typesetDirectory(documentID, revision)
	data, err := os.ReadFile(filepath.Join(root, "result.json"))
	stat, fileErr := os.Stat(filepath.Join(root, "translation.pdf"))
	if err != nil || fileErr != nil || !stat.Mode().IsRegular() || stat.Size() < 5 || !typesetPositionsExist(root) || json.Unmarshal(data, &status) != nil || status.Status != "complete" || status.Revision != revision {
		return status, false
	}
	return status, true
}

func (s *Server) pdfTypeset(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	ctx, finish, err := s.beginDocumentTask(context.WithoutCancel(r.Context()), documentID)
	if err != nil {
		fail(w, 409, "文档暂不可用")
		return
	}
	snapshot, revision, err := s.typesetSnapshot(documentID)
	if err != nil {
		finish()
		fail(w, 409, "请等待正文解析完成后重试")
		return
	}
	status := pdfTypesetStatus{Status: "idle", Revision: revision}
	if len(snapshot.Blocks) == 0 {
		status.Status, status.Reason = "waiting", "translation_pending"
	}
	if cached, ok := s.cachedTypeset(documentID, revision); ok {
		finish()
		respond(w, 200, cached)
		return
	}
	if processing, err := s.Store.processing(documentID); err == nil && (processing.Phase == "learning" && processing.Status == "running" || processing.Translating != nil && processing.Translating.Status == "running") {
		status.Status, status.Reason = "waiting", "translation_pending"
	}
	root, python, worker, runtimeErr := typesetRuntime()
	if runtimeErr != nil && status.Status == "idle" {
		status.Status, status.Reason = "unavailable", "runtime_missing"
	}
	s.typeset.mu.Lock()
	if s.typeset.jobs == nil {
		s.typeset.jobs = map[string]pdfTypesetStatus{}
		s.typeset.lane = make(chan struct{}, 1)
	}
	if job, ok := s.typeset.jobs[documentID]; ok && job.Revision == revision {
		if job.Status == "running" || job.Status == "failed" && r.Method == http.MethodGet {
			status = job
		}
	}
	if r.Method != http.MethodPost || (status.Status != "idle" && status.Status != "failed") || runtimeErr != nil {
		s.typeset.mu.Unlock()
		finish()
		respond(w, 200, status)
		return
	}
	status.Status, status.Reason = "running", ""
	s.typeset.jobs[documentID] = status
	s.typeset.mu.Unlock()
	go func() { defer finish(); s.runPDFTypeset(ctx, documentID, revision, snapshot, root, python, worker) }()
	respond(w, http.StatusAccepted, status)
}

func (s *Server) runPDFTypeset(parent context.Context, documentID, revision string, snapshot pdfTypesetSnapshot, runtimeRoot, python, worker string) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	defer cancel()
	started, runID := time.Now(), id()
	status := pdfTypesetStatus{Status: "failed", Revision: revision, Reason: "engine_failed", Pages: snapshot.Manifest.Pages}
	s.diagnosticEvent(slog.LevelInfo, "pdf.typeset.start", "runId", runID, "documentId", documentID, "version", typesetVersion)
	defer func() {
		if ctx.Err() != nil {
			status.Status, status.Reason = "failed", "cancelled"
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				status.Reason = "timeout"
			}
		}
		s.typeset.mu.Lock()
		if s.typeset.jobs[documentID].Revision == revision {
			s.typeset.jobs[documentID] = status
		}
		s.typeset.mu.Unlock()
		level := slog.LevelInfo
		if status.Status != "complete" && ctx.Err() == nil {
			level = slog.LevelError
		}
		s.diagnosticEvent(level, "pdf.typeset.finish", "runId", runID, "documentId", documentID, "outcome", status.Status, "reasonCode", status.Reason, "durationMs", time.Since(started).Milliseconds(), "translatedBlocks", status.Translated, "preservedBlocks", status.Preserved)
	}()
	select {
	case s.typeset.lane <- struct{}{}:
		defer func() { <-s.typeset.lane }()
	case <-ctx.Done():
		return
	}
	if ctx.Err() != nil {
		return
	}
	if _, current, err := s.typesetSnapshot(documentID); err != nil || current != revision {
		status.Reason = "snapshot_changed"
		return
	}
	if cached, ok := s.cachedTypeset(documentID, revision); ok {
		status = cached
		return
	}
	base := filepath.Dir(s.typesetDirectory(documentID, revision))
	if os.MkdirAll(base, 0700) != nil {
		status.Reason = "save_failed"
		return
	}
	// Single generation lane + library process lock: pending directories here
	// belong to a process that stopped before it could commit or clean up.
	if entries, err := os.ReadDir(base); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), ".pending-") {
				_ = os.RemoveAll(filepath.Join(base, entry.Name()))
			}
		}
	}
	work, err := os.MkdirTemp(base, ".pending-")
	if err != nil {
		status.Reason = "save_failed"
		return
	}
	defer os.RemoveAll(work)
	data, _ := json.Marshal(snapshot)
	if os.WriteFile(filepath.Join(work, "snapshot.json"), data, 0600) != nil {
		status.Reason = "save_failed"
		return
	}
	d, err := s.Store.Document(documentID)
	if err != nil {
		return
	}
	cmd := exec.CommandContext(ctx, python, worker, "--snapshot", filepath.Join(work, "snapshot.json"), "--input", s.Store.File(d), "--output", filepath.Join(work, "translation.pdf"), "--assets", filepath.Join(runtimeRoot, "assets"))
	cmd.Dir = work
	cmd.Env = append(os.Environ(), "PYTHONPATH="+filepath.Join(runtimeRoot, "site"), "PYTHONNOUSERSITE=1", "PYTHONDONTWRITEBYTECODE=1")
	cmd.Stderr = io.Discard // Upstream can include document prose; never persist raw stderr.
	cmd.WaitDelay = 3 * time.Second
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		status.Reason = "runtime_failed"
		return
	}
	scanner := bufio.NewScanner(out)
	finished := false
	lastPhase := ""
	for scanner.Scan() {
		var event struct {
			Phase                string `json:"phase"`
			Type                 string `json:"type"`
			Reason               string `json:"reason"`
			Translated           int    `json:"translated"`
			Preserved            int    `json:"preserved"`
			TranslatedCharacters int    `json:"translatedCharacters"`
			PreservedCharacters  int    `json:"preservedCharacters"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		if event.Type == "stage" && event.Phase != lastPhase {
			switch event.Phase {
			case "parsing", "layout", "paragraphs", "formulas", "mapping", "typesetting", "saving":
				lastPhase = event.Phase
				s.diagnosticEvent(slog.LevelInfo, "pdf.typeset.stage", "runId", runID, "documentId", documentID, "phase", lastPhase)
				s.typeset.mu.Lock()
				if job := s.typeset.jobs[documentID]; job.Revision == revision {
					job.Phase = lastPhase
					s.typeset.jobs[documentID] = job
				}
				s.typeset.mu.Unlock()
			}
		}
		if event.Type == "finish" && event.Translated > 0 {
			finished = true
			status.Translated, status.Preserved = event.Translated, event.Preserved
			status.TranslatedCharacters, status.PreservedCharacters = event.TranslatedCharacters, event.PreservedCharacters
		}
		if event.Type == "error" {
			switch event.Reason {
			case "runtime_version", "offline_resource_missing", "no_mapped_translation", "page_mismatch":
				status.Reason = event.Reason
			}
		}
	}
	if err = cmd.Wait(); err != nil || scanner.Err() != nil || !finished || ctx.Err() != nil {
		return
	}
	// A retranslation or reparse during generation must never publish stale output.
	_, current, err := s.typesetSnapshot(documentID)
	if err != nil || current != revision {
		status.Reason = "snapshot_changed"
		return
	}
	file, err := os.Open(filepath.Join(work, "translation.pdf"))
	if err != nil {
		status.Reason = "save_failed"
		return
	}
	header := make([]byte, 5)
	_, err = io.ReadFull(file, header)
	file.Close()
	if err != nil || string(header) != "%PDF-" {
		status.Reason = "invalid_output"
		return
	}
	status.Status, status.Reason = "complete", ""
	data, _ = json.Marshal(status)
	if os.WriteFile(filepath.Join(work, "result.json"), data, 0600) != nil {
		status.Status, status.Reason = "failed", "save_failed"
		return
	}
	if err := validateTypesetPositions(filepath.Join(work, "positions.json"), snapshot, revision); err != nil {
		status.Status, status.Reason = "failed", "invalid_positions"
		return
	}
	// Keep only the PDF + summary + verified positions. Working IR contains prose and is disposable.
	entries, err := os.ReadDir(work)
	if err != nil {
		status.Status, status.Reason = "failed", "save_failed"
		return
	}
	for _, entry := range entries {
		if entry.Name() != "translation.pdf" && entry.Name() != "result.json" && entry.Name() != "positions.json" {
			if os.RemoveAll(filepath.Join(work, entry.Name())) != nil {
				status.Status, status.Reason = "failed", "save_failed"
				return
			}
		}
	}
	destination := s.typesetDirectory(documentID, revision)
	// Only an invalid cache can be here: a valid result was reused above.
	if ctx.Err() != nil {
		return
	}
	if os.RemoveAll(destination) != nil || os.Rename(work, destination) != nil {
		status.Status, status.Reason = "failed", "save_failed"
		return
	}
	// Revisions are replaceable artifacts. Retain only the current completed
	// PDF, rather than growing the library on every retranslation.
	if entries, err := os.ReadDir(base); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && entry.Name() != revision && typesetResource.MatchString("typeset/"+entry.Name()+".pdf") {
				_ = os.RemoveAll(filepath.Join(base, entry.Name()))
			}
		}
	}
}

var typesetResource = regexp.MustCompile(`^typeset/([a-f0-9]{64})\.pdf$`)

func (s *Server) serveTypeset(w http.ResponseWriter, r *http.Request, documentID, revision string) {
	_, finish, err := s.beginDocumentTask(r.Context(), documentID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer finish()
	_, current, err := s.typesetSnapshot(documentID)
	if err != nil || current != revision {
		fail(w, 409, "译文已变化，请重新生成排版")
		return
	}
	if _, ok := s.cachedTypeset(documentID, revision); !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(s.typesetDirectory(documentID, revision), "translation.pdf"))
}

func typesetPositionsExist(root string) bool {
	stat, err := os.Stat(filepath.Join(root, "positions.json"))
	return err == nil && stat.Mode().IsRegular() && stat.Size() > 0 && stat.Size() <= 32<<20
}

func (s *Server) pdfTypesetPositions(w http.ResponseWriter, r *http.Request) {
	documentID, revision := r.PathValue("id"), r.URL.Query().Get("revision")
	_, finish, err := s.beginDocumentTask(r.Context(), documentID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer finish()
	_, current, err := s.typesetSnapshot(documentID)
	if err != nil || current != revision {
		fail(w, 409, "译文已变化，请重新生成排版")
		return
	}
	if _, ok := s.cachedTypeset(documentID, revision); !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(s.typesetDirectory(documentID, revision), "positions.json"))
}
