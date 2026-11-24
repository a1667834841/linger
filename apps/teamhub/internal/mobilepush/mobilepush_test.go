package mobilepush

import "testing"

func TestClassify(t *testing.T) {
	cases := []struct {
		kind      string
		anotherMe bool
		decision  bool
		want      string
	}{
		{"conversation", true, false, KindMessage},
		{"conversation", true, true, KindDecision},
		{"conversation", false, true, KindDecision},
		{"conversation", false, false, ""},
		{"agent_runtime", true, false, ""},
		{"task_terminal_notice", true, false, ""},
		{"room_notice", true, false, ""},
	}
	for _, c := range cases {
		if got := Classify(c.kind, c.anotherMe, c.decision); got != c.want {
			t.Errorf("Classify(%q, %v, %v) = %q, want %q", c.kind, c.anotherMe, c.decision, got, c.want)
		}
	}
}
