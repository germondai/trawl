package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/Lu1sDV/wafmeow/v3/pkg/wafmeow"
)

type detection struct {
	Engine             string          `json:"engine"`
	Version            string          `json:"version"`
	State              string          `json:"state"`
	Products           []string        `json:"products"`
	Matches            []wafmeow.Match `json:"matches,omitempty"`
	IncompleteProducts []string        `json:"incompleteProducts,omitempty"`
	Diagnostics        []diagnostic    `json:"diagnostics,omitempty"`
	DetailsTruncated   bool            `json:"detailsTruncated,omitempty"`
}

type diagnostic struct {
	Code     string `json:"code"`
	Evidence int    `json:"evidence"`
}

// The worker only classifies supplied evidence; it never acquires URLs or probes sites.
func classify(input io.Reader, output io.Writer, engine *wafmeow.Engine) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 160<<10)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var evidence wafmeow.Evidence
		if err := json.Unmarshal(scanner.Bytes(), &evidence); err != nil {
			return errors.New("invalid evidence")
		}
		outcome := engine.Classify([]wafmeow.Evidence{evidence})
		result := detection{
			Engine: "wafmeow", Version: "3.1.0", State: string(outcome.State), Products: []string{},
			IncompleteProducts: outcome.IncompleteProducts,
		}
		for _, match := range outcome.Matches {
			result.Products = append(result.Products, match.Product)
			// Bound rule details independently of the complete provider list.
			if len(result.Matches) == 32 {
				result.DetailsTruncated = true
				continue
			}
			if len(match.Fingerprints) > 16 {
				match.Fingerprints = match.Fingerprints[:16]
				result.DetailsTruncated = true
			}
			result.Matches = append(result.Matches, match)
		}
		for _, item := range outcome.Diagnostics {
			code := item.Code
			switch code {
			case "body_truncated", "missing_response", "invalid_engine", "invalid_evidence", "transport_error":
			default:
				code = "transport_error"
			}
			result.Diagnostics = append(result.Diagnostics, diagnostic{code, item.Evidence})
		}
		if err := encoder.Encode(result); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func run() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	catalogue, err := os.Open(filepath.Join(filepath.Dir(executable), "waf-fingerprints.json"))
	if err != nil {
		return err
	}
	rules, err := wafmeow.ReadCatalogue(catalogue)
	catalogue.Close()
	if err != nil {
		return err
	}
	engine, err := wafmeow.Compile(rules)
	if err != nil {
		return err
	}
	return classify(os.Stdin, os.Stdout, engine)
}

func main() {
	if run() != nil {
		os.Exit(1)
	}
}
