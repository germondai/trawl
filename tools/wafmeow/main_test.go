package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	if len(result.Matches) != 1 || result.Matches[0].Schema != 1 || result.Matches[0].Product != "Cloudflare" {
		t.Fatalf("missing matched rule references: %+v", result.Matches)
	}
	refs := result.Matches[0].Fingerprints
	if len(refs) != 1 || refs[0].Fingerprint != 1 || refs[0].Evidence != 0 {
		t.Fatalf("unexpected evidence references: %+v", refs)
	}
}

func TestClassifyReportsIncompleteProductsAndSafeDiagnosticCodes(t *testing.T) {
	engine, err := wafmeow.Compile([]wafmeow.WAF{
		{Name: "Cloudflare", Schemas: []wafmeow.Scheme{{FingerPrints: []wafmeow.FingerPrint{{Type: "Header", HeaderKey: "server", HeaderValue: "cloudflare"}}}}},
		{Name: "Body provider", Schemas: []wafmeow.Scheme{{FingerPrints: []wafmeow.FingerPrint{{Type: "Content", Pattern: "private"}}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := `{"role":"Normal","status_code":200,"headers":[{"name":"server","value":"cloudflare"}],"body":"cHJpdmF0ZQ==","body_truncated":true,"error_code":"private-code","transport_error":"private-url"}`
	var output bytes.Buffer
	if err := classify(strings.NewReader(input), &output, engine); err != nil {
		t.Fatal(err)
	}
	var result detection
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "incomplete" || len(result.Products) != 1 || result.Products[0] != "Cloudflare" ||
		len(result.IncompleteProducts) != 1 || result.IncompleteProducts[0] != "Body provider" {
		t.Fatalf("unexpected partial result: %+v", result)
	}
	if len(result.Diagnostics) != 2 || result.Diagnostics[0] != (diagnostic{"transport_error", 0}) || result.Diagnostics[1] != (diagnostic{"body_truncated", 0}) {
		t.Fatalf("unexpected diagnostic codes: %+v", result.Diagnostics)
	}
	if strings.Contains(output.String(), "private") || strings.Contains(output.String(), "cHJpdmF0ZQ") {
		t.Fatal("worker echoed evidence or diagnostic messages")
	}
}

func TestClassifyBoundsRuleDetailsWithoutDroppingProviders(t *testing.T) {
	rules := make([]wafmeow.WAF, 40)
	for i := range rules {
		rules[i] = wafmeow.WAF{Name: fmt.Sprintf("Provider %d", i), Schemas: []wafmeow.Scheme{{
			FingerPrints: []wafmeow.FingerPrint{{Type: "Header", HeaderKey: "server", HeaderValue: "cloudflare"}},
		}}}
	}
	engine, err := wafmeow.Compile(rules)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := classify(strings.NewReader(`{"status_code":200,"headers":[{"name":"server","value":"cloudflare"}]}`), &output, engine); err != nil {
		t.Fatal(err)
	}
	var result detection
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Products) != 40 || len(result.Matches) != 32 || !result.DetailsTruncated || output.Len() >= 32768 {
		t.Fatalf("unexpected detail limits: %+v", result)
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
