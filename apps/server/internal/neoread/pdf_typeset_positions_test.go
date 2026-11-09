package neoread

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestTypesetPositionsValidation(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "已保存译文")
	snapshot, revision, err := s.typesetSnapshot("doc")
	if err != nil {
		t.Fatal(err)
	}
	b := snapshot.Blocks[0]
	valid := typesetPositions{Version: 1, Blocks: []typesetPositionBlock{{
		BlockID: b.ID, SourceHash: b.SourceHash, Page: b.Page, Targets: []string{b.Sentences[0].Target}, Status: "mapped",
		Sentences: []typesetSentence{{Index: 0, Glyphs: []typesetGlyph{{Text: "译", Bounds: typesetRect{X: .1, Y: .2, Width: .01, Height: .02}}}}},
	}}}
	for _, test := range []struct {
		name   string
		change func(*typesetPositions)
	}{
		{"valid", func(p *typesetPositions) {}},
		{"fallback", func(p *typesetPositions) {
			p.Blocks[0].Status = "fallback"
			p.Blocks[0].Sentences = nil
			p.Blocks[0].Reason = "arbitrary text"
		}},
		{"wrong version", func(p *typesetPositions) { p.Version = 2 }},
		{"missing block", func(p *typesetPositions) { p.Blocks = nil }},
		{"duplicate block", func(p *typesetPositions) { p.Blocks = append(p.Blocks, p.Blocks[0]) }},
		{"unknown block", func(p *typesetPositions) { p.Blocks[0].BlockID = "other" }},
		{"wrong page", func(p *typesetPositions) { p.Blocks[0].Page++ }},
		{"old hash", func(p *typesetPositions) { p.Blocks[0].SourceHash = "old" }},
		{"old target", func(p *typesetPositions) { p.Blocks[0].Targets[0] = "old" }},
		{"missing target", func(p *typesetPositions) { p.Blocks[0].Targets = nil }},
		{"wrong sentence", func(p *typesetPositions) { p.Blocks[0].Sentences[0].Index = 1 }},
		{"missing glyphs", func(p *typesetPositions) { p.Blocks[0].Sentences[0].Glyphs = nil }},
		{"outside page", func(p *typesetPositions) { p.Blocks[0].Sentences[0].Glyphs[0].Bounds.X = 1 }},
		{"empty text", func(p *typesetPositions) { p.Blocks[0].Sentences[0].Glyphs[0].Text = "" }},
		{"fallback with positions", func(p *typesetPositions) { p.Blocks[0].Status = "fallback" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, _ := json.Marshal(valid)
			var p typesetPositions
			json.Unmarshal(data, &p)
			test.change(&p)
			data, _ = json.Marshal(p)
			path := filepath.Join(t.TempDir(), "positions.json")
			os.WriteFile(path, data, 0600)
			err := validateTypesetPositions(path, snapshot, revision)
			if test.name != "valid" && test.name != "fallback" {
				if err == nil {
					t.Fatal("accepted invalid positions")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			data, _ = os.ReadFile(path)
			json.Unmarshal(data, &p)
			if p.Revision != revision {
				t.Fatal("missing revision")
			}
			if test.name == "fallback" && p.Blocks[0].Reason != "unverified_positions" {
				t.Fatal("reason not normalized")
			}
		})
	}
}

func TestPDFTypesetPositionsRequireCurrentAuthenticatedArtifact(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "第一版")
	fakeTypesetRuntime(t, s, `printf '%%PDF-1.7\n' > "$target"
printf '{"type":"finish","translated":1}\n'
`)
	typesetStatus(t, s, "POST")
	status := awaitTypeset(t, s)
	if status.Status != "complete" {
		t.Fatal(status)
	}
	path := "/api/documents/doc/translations/typeset/positions?revision=" + status.Revision
	w := request(t, s, "GET", path, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var p typesetPositions
	if json.Unmarshal(w.Body.Bytes(), &p) != nil || p.Revision != status.Revision {
		t.Fatal(w.Body.String())
	}
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 401 && w.Code != 403 {
		t.Fatal("unauthenticated positions", w.Code)
	}
	saveExportTranslation(t, s, m.Blocks[0], "第二版")
	w = request(t, s, "GET", path, nil)
	if w.Code != 409 {
		t.Fatal("served stale positions", w.Code)
	}
}
