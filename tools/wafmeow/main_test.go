package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Lu1sDV/wafmeow/v3/pkg/wafmeow"
)

func testEngine(t *testing.T) *wafmeow.Engine {
	t.Helper()
	engine, err := wafmeow.Compile([]wafmeow.WAF{{Name: "Cloudflare", Schemas: []wafmeow.Scheme{{
		FingerPrints: []wafmeow.FingerPrint{{Type: "Header", HeaderKey: "server", HeaderValue: "cloudflare"}},
	}}}})
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func TestClassifyStreamsMetadataWithoutEchoingEvidence(t *testing.T) {
	input := `{"role":"Normal","status_code":200,"headers":[{"name":"server","value":"cloudflare"}],"body":"cHJpdmF0ZQ=="}`
	var output bytes.Buffer
	if err := classify(strings.NewReader(input+"\n"+input+"\n"), &output, testEngine(t)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "private") || strings.Contains(output.String(), "cHJpdmF0ZQ") {
		t.Fatal("worker echoed evidence")
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatal("expected one result per observation")
	}
	var result detection
	if err := json.Unmarshal([]byte(lines[0]), &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "complete" || len(result.Products) != 1 || result.Products[0] != "Cloudflare" {
		t.Fatalf("unexpected detection: %+v", result)
	}
}

func TestClassifyRejectsInvalidAndOversizedRecords(t *testing.T) {
	for _, input := range []string{`{"unknown":true}`, strings.Repeat("x", 160<<10)} {
		var output bytes.Buffer
		if classify(strings.NewReader(input), &output, testEngine(t)) == nil || output.Len() != 0 {
			t.Fatal("invalid input produced a result")
		}
	}
}
