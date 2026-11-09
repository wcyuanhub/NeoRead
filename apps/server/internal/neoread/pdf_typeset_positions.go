package neoread

import (
	"encoding/json"
	"errors"
	"math"
	"os"
)

type typesetRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type typesetGlyph struct {
	Text   string      `json:"text"`
	Bounds typesetRect `json:"bounds"`
}
type typesetSentence struct {
	Index  int            `json:"index"`
	Glyphs []typesetGlyph `json:"glyphs"`
}
type typesetPositionBlock struct {
	BlockID    string            `json:"blockId"`
	SourceHash string            `json:"sourceHash"`
	Targets    []string          `json:"targets"`
	Page       int               `json:"page"`
	Status     string            `json:"status"`
	Reason     string            `json:"reason,omitempty"`
	Sentences  []typesetSentence `json:"sentences"`
}
type typesetPositions struct {
	Version  int                    `json:"version"`
	Revision string                 `json:"revision"`
	Blocks   []typesetPositionBlock `json:"blocks"`
}

func validateTypesetPositions(path string, snapshot pdfTypesetSnapshot, revision string) error {
	invalid := errors.New("invalid_positions")
	stat, err := os.Stat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 32<<20 {
		return invalid
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var positions typesetPositions
	if json.Unmarshal(data, &positions) != nil || positions.Version != 1 || len(positions.Blocks) != len(snapshot.Blocks) {
		return invalid
	}
	expected := map[string]pdfTypesetBlock{}
	for _, block := range snapshot.Blocks {
		expected[block.ID] = block
	}
	for i := range positions.Blocks {
		block := &positions.Blocks[i]
		source, ok := expected[block.BlockID]
		if !ok || source.Page != block.Page || source.SourceHash != block.SourceHash || len(source.Sentences) != len(block.Targets) {
			return invalid
		}
		delete(expected, block.BlockID)
		for i, target := range block.Targets {
			if source.Sentences[i].Target != target {
				return invalid
			}
		}
		if block.Status == "fallback" {
			if len(block.Sentences) != 0 {
				return invalid
			}
			block.Reason = "unverified_positions"
			continue
		}
		if block.Status != "mapped" || len(block.Sentences) != len(source.Sentences) {
			return invalid
		}
		for i, sentence := range block.Sentences {
			if sentence.Index != i || len(sentence.Glyphs) == 0 {
				return invalid
			}
			for _, g := range sentence.Glyphs {
				r := g.Bounds
				for _, v := range []float64{r.X, r.Y, r.Width, r.Height} {
					if math.IsNaN(v) || math.IsInf(v, 0) {
						return invalid
					}
				}
				if g.Text == "" || len(g.Text) > 64 || r.X < 0 || r.Y < 0 || r.Width <= 0 || r.Height <= 0 || r.X+r.Width > 1.001 || r.Y+r.Height > 1.001 {
					return invalid
				}
			}
		}
	}
	positions.Revision = revision
	data, err = json.Marshal(positions)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
