package neoread

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func fakeTypesetRuntime(t *testing.T, output string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX worker fixture")
	}
	root := t.TempDir()
	if err := os.Symlink("/bin/sh", filepath.Join(root, "python")); err != nil {
		t.Fatal(err)
	}
	script := "while [ \"$#\" -gt 0 ]; do\nif [ \"$1\" = \"--output\" ]; then shift; target=\"$1\"; fi\nshift\ndone\n" + output
	if err := os.WriteFile(filepath.Join(root, "worker.py"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "runtime.json"), []byte(`{"python":"python","version":"0.6.4"}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_BABELDOC", root)
	return root
}

func typesetStatus(t *testing.T, s *Server, method string) pdfTypesetStatus {
	t.Helper()
	w := request(t, s, method, "/api/documents/doc/translations/typeset", nil)
	if w.Code != 200 && w.Code != 202 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	var status pdfTypesetStatus
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func awaitTypeset(t *testing.T, s *Server) pdfTypesetStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status := typesetStatus(t, s, "GET")
		if status.Status != "running" {
			return status
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("typeset did not finish")
	return pdfTypesetStatus{}
}

func TestPDFTypesetSnapshotAndAvailability(t *testing.T) {
	s, _, m := translationFixture(t)
	t.Setenv("NEOREAD_BABELDOC", "")
	if status := typesetStatus(t, s, "POST"); status.Status != "waiting" {
		t.Fatal(status)
	}
	saveExportTranslation(t, s, m.Blocks[0], "已保存的译文")
	snapshot, first, err := s.typesetSnapshot("doc")
	if err != nil || len(snapshot.Blocks) != 1 {
		t.Fatal(snapshot, err)
	}
	if status := typesetStatus(t, s, "POST"); status.Status != "unavailable" || status.Reason != "runtime_missing" {
		t.Fatal(status)
	}
	saveExportTranslation(t, s, m.Blocks[0], "修改后的译文")
	_, second, _ := s.typesetSnapshot("doc")
	if first == second {
		t.Fatal("translation change did not invalidate cache")
	}
	m.Blocks[0].Text = "Changed source."
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, _, _ = s.typesetSnapshot("doc")
	if len(snapshot.Blocks) != 0 {
		t.Fatal("stale translation entered snapshot")
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("POST", "/api/documents/doc/translations/typeset", nil))
	if w.Code != 401 && w.Code != 403 {
		t.Fatal("unauthorized generation", w.Code)
	}
}

func TestPDFTypesetPublishesAtomicallyAndRejectsOldRevision(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "第一版译文")
	fakeTypesetRuntime(t, `printf '%%PDF-1.7\n' > "$target"
printf '{"type":"finish","translated":1,"preserved":2}\n'
`)
	before, _ := s.Store.processing("doc")
	if status := typesetStatus(t, s, "POST"); status.Status != "running" {
		t.Fatal(status)
	}
	status := awaitTypeset(t, s)
	if status.Status != "complete" || status.Translated != 1 {
		t.Fatal(status)
	}
	path := "/pub/test-secret/doc/typeset/" + status.Revision + ".pdf"
	w := request(t, s, "GET", path, nil)
	if w.Code != 200 || !strings.HasPrefix(w.Body.String(), "%PDF-") {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.typesetDirectory("doc", status.Revision), "snapshot.json")); !os.IsNotExist(err) {
		t.Fatal("private snapshot retained", err)
	}
	saveExportTranslation(t, s, m.Blocks[0], "第二版译文")
	w = request(t, s, "GET", path, nil)
	if w.Code != 409 {
		t.Fatal("stale PDF was served", w.Code)
	}
	after, _ := s.Store.processing("doc")
	if jsonText(before) != jsonText(after) {
		t.Fatal("generation changed translation processing")
	}
}

func TestPDFTypesetRejectsIncompleteWorkerAndCleansWork(t *testing.T) {
	for _, script := range []string{
		`printf '%%PDF-1.7\n' > "$target"`,
		`printf 'invalid PDF' > "$target"; printf '{"type":"finish","translated":1}\n'`,
		`printf '{"type":"finish","translated":1}\n'; exit 1`,
	} {
		s, _, m := translationFixture(t)
		saveExportTranslation(t, s, m.Blocks[0], "译文")
		fakeTypesetRuntime(t, script)
		typesetStatus(t, s, "POST")
		status := awaitTypeset(t, s)
		if status.Status != "failed" {
			t.Fatal(status)
		}
		if _, ok := s.cachedTypeset("doc", status.Revision); ok {
			t.Fatal("failed worker published output")
		}
		entries, _ := os.ReadDir(filepath.Dir(s.typesetDirectory("doc", status.Revision)))
		if len(entries) != 0 {
			t.Fatal("failed job retained document data", entries)
		}
	}
}

func TestPDFTypesetCancellationFinishesDocumentTask(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "译文")
	fakeTypesetRuntime(t, "exit 1")
	snapshot, revision, _ := s.typesetSnapshot("doc")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.typeset.jobs = map[string]pdfTypesetStatus{"doc": {Status: "running", Revision: revision}}
	s.typeset.lane = make(chan struct{}, 1)
	s.typeset.lane <- struct{}{}
	root, python, worker, _ := typesetRuntime()
	s.runPDFTypeset(ctx, "doc", revision, snapshot, root, python, worker)
	if s.typeset.jobs["doc"].Reason != "cancelled" {
		t.Fatal(s.typeset.jobs["doc"])
	}
}

func TestPDFTypesetSnapshotIncludesCaptionOnly(t *testing.T) {
	s, _, m := translationFixture(t)
	b := m.Blocks[0]
	b.Image, b.Caption, b.Label, b.Text = "assets/"+b.ID+".png", "Figure 1: Caption.", "chart", "labels inside figure"
	m.Blocks[0] = b
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	item := newTranslation(b)
	item.Status = "complete"
	item.Sentences = []TranslationSentence{{Source: b.Caption, Target: "图 1：图注。"}}
	if err := s.saveTranslation("doc", item); err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := s.typesetSnapshot("doc")
	if err != nil || len(snapshot.Blocks) != 1 || snapshot.Blocks[0].Text != b.Caption {
		t.Fatal(snapshot, err)
	}
}

func TestPDFTypesetCloseCancelsRegisteredQueuedJob(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "译文")
	fakeTypesetRuntime(t, "exit 1")
	s.typeset.jobs = map[string]pdfTypesetStatus{}
	s.typeset.lane = make(chan struct{}, 1)
	s.typeset.lane <- struct{}{}
	status := typesetStatus(t, s, "POST")
	if status.Status != "running" {
		t.Fatal(status)
	}
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("server close did not wait for cancelled typeset job")
	}
	s.typeset.mu.Lock()
	defer s.typeset.mu.Unlock()
	if s.typeset.jobs["doc"].Reason != "cancelled" {
		t.Fatal(s.typeset.jobs["doc"])
	}
	if _, ok := s.cachedTypeset("doc", status.Revision); ok {
		t.Fatal("cancelled job published output")
	}
}

func TestPDFTypesetRejectsInvalidRuntimeManifest(t *testing.T) {
	root := fakeTypesetRuntime(t, "exit 1")
	for _, config := range []string{`{"python":"../python","version":"0.6.4"}`, `{"python":"/bin/sh","version":"0.6.4"}`, `{"python":"python","version":"new"}`} {
		if err := os.WriteFile(filepath.Join(root, "runtime.json"), []byte(config), 0600); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := typesetRuntime(); err == nil {
			t.Fatal("accepted invalid runtime manifest", config)
		}
	}
}
