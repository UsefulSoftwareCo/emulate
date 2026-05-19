package sqs

import (
	"testing"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func TestReserveVisibleMessageRejectsStaleSnapshot(t *testing.T) {
	store := corestore.New()
	messages := store.MustCollection("aws.sqs_messages", "message_id", "queue_name")
	now := int64(1000)
	snapshot := messages.Insert(corestore.Record{
		"queue_name":     "jobs",
		"message_id":     "m1",
		"receipt_handle": "old",
		"visible_after":  now,
		"receive_count":  0,
	})
	handler := Handler{
		Messages: messages,
		ReceiptGenerator: func() string {
			return "receipt"
		},
	}

	reserved, ok := handler.reserveVisibleMessage(snapshot, now, 30)
	if !ok {
		t.Fatal("first reservation failed")
	}
	if got := stringField(reserved, "receipt_handle"); got != "receipt" {
		t.Fatalf("receipt handle = %q", got)
	}
	if got := int64Field(reserved, "visible_after"); got != now+30000 {
		t.Fatalf("visible_after = %d", got)
	}
	if got := intField(reserved, "receive_count"); got != 1 {
		t.Fatalf("receive_count = %d", got)
	}

	stale, ok := handler.reserveVisibleMessage(snapshot, now, 30)
	if ok || stale != nil {
		t.Fatalf("stale reservation succeeded: %#v %v", stale, ok)
	}
	current, ok := messages.Get(intField(snapshot, "id"))
	if !ok {
		t.Fatal("message disappeared")
	}
	if got := intField(current, "receive_count"); got != 1 {
		t.Fatalf("receive_count after stale reservation = %d", got)
	}
}
