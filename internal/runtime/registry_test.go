package runtime

import "testing"

func TestServiceNamesPreserveRegistryOrder(t *testing.T) {
	got := ServiceNames()
	want := []string{"vercel", "github", "google", "slack", "apple", "microsoft", "okta", "aws", "resend", "stripe", "mongoatlas", "clerk"}
	if len(got) != len(want) {
		t.Fatalf("got %d services, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("service %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestStarterConfigIncludesTokensAndSelectedService(t *testing.T) {
	config, err := StarterConfig("aws")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := config["tokens"]; !ok {
		t.Fatal("starter config is missing tokens")
	}
	if _, ok := config["aws"]; !ok {
		t.Fatal("starter config is missing selected service")
	}
	if _, ok := config["github"]; ok {
		t.Fatal("service-specific starter config included an unrelated service")
	}
}

func TestAWSStarterConfigUsesAppSpecificKMSAlias(t *testing.T) {
	config, err := StarterConfig("aws")
	if err != nil {
		t.Fatal(err)
	}
	awsConfig, ok := config["aws"].(map[string]any)
	if !ok {
		t.Fatalf("aws config = %#v", config["aws"])
	}
	kmsConfig, ok := awsConfig["kms"].(map[string]any)
	if !ok {
		t.Fatalf("kms config = %#v", awsConfig["kms"])
	}
	keys, ok := kmsConfig["keys"].([]map[string]any)
	if !ok || len(keys) != 1 {
		t.Fatalf("kms keys = %#v", kmsConfig["keys"])
	}
	aliases, ok := keys[0]["aliases"].([]string)
	if !ok {
		t.Fatalf("kms aliases = %#v", keys[0]["aliases"])
	}
	if len(aliases) != 1 || aliases[0] != "alias/my-app" {
		t.Fatalf("kms aliases = %#v, want alias/my-app", aliases)
	}
}

func TestStarterConfigRejectsUnknownService(t *testing.T) {
	if _, err := StarterConfig("unknown"); err == nil {
		t.Fatal("expected unknown service error")
	}
}
