package aws

import (
	"fmt"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
)

var inspectorTabs = []ui.InspectorTab{
	{ID: "s3", Label: "S3", Href: "/_inspector?tab=s3"},
	{ID: "sqs", Label: "SQS", Href: "/_inspector?tab=sqs"},
	{ID: "iam", Label: "IAM", Href: "/_inspector?tab=iam"},
}

func (s *Service) handleInspector(c *corehttp.Context) {
	tab := c.Query("tab")
	if tab != "s3" && tab != "sqs" && tab != "iam" {
		tab = "s3"
	}
	tabs := make([]ui.InspectorTab, len(inspectorTabs))
	for index, item := range inspectorTabs {
		tabs[index] = item
		tabs[index].Active = item.ID == tab
	}

	var body string
	switch tab {
	case "sqs":
		body = s.renderSQSInspector()
	case "iam":
		body = s.renderIAMInspector()
	default:
		body = s.renderS3Inspector()
	}

	c.HTML(200, ui.RenderInspectorPage("Inspector", tabs, tab, body, ui.PageOptions{Service: "AWS"}))
}

func (s *Service) renderS3Inspector() string {
	buckets := s.store.S3Buckets.All()
	var rows strings.Builder
	for _, bucket := range buckets {
		name := stringField(bucket, "bucket_name")
		objects := s.store.S3Objects.FindBy("bucket_name", name)
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(name))
		rows.WriteString(`</td><td>`)
		rows.WriteString(fmt.Sprint(len(objects)))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(bucket, "region")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(bucket, "creation_date")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>S3 Buckets (` + fmt.Sprint(len(buckets)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Bucket</th><th>Objects</th><th>Region</th><th>Created</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 4, "No buckets") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderSQSInspector() string {
	queues := s.store.SQSQueues.All()
	var rows strings.Builder
	for _, queue := range queues {
		name := stringField(queue, "queue_name")
		messages := s.store.SQSMessages.FindBy("queue_name", name)
		rows.WriteString(`<tr><td>`)
		rows.WriteString(ui.EscapeHTML(name))
		rows.WriteString(`</td><td>`)
		rows.WriteString(fmt.Sprint(len(messages)))
		rows.WriteString(`</td><td>`)
		rows.WriteString(yesNo(boolField(queue, "fifo")))
		rows.WriteString(`</td><td>`)
		rows.WriteString(ui.EscapeHTML(stringField(queue, "visibility_timeout")))
		rows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>SQS Queues (` + fmt.Sprint(len(queues)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Queue</th><th>Messages</th><th>FIFO</th><th>Visibility Timeout</th></tr></thead>
    <tbody>` + rowsOrEmpty(rows.String(), 4, "No queues") + `</tbody>
  </table>
</div>`
}

func (s *Service) renderIAMInspector() string {
	users := s.store.IAMUsers.All()
	roles := s.store.IAMRoles.All()
	var userRows strings.Builder
	for _, user := range users {
		userRows.WriteString(`<tr><td>`)
		userRows.WriteString(ui.EscapeHTML(stringField(user, "user_name")))
		userRows.WriteString(`</td><td>`)
		userRows.WriteString(ui.EscapeHTML(stringField(user, "user_id")))
		userRows.WriteString(`</td><td>`)
		userRows.WriteString(fmt.Sprint(accessKeyCount(user)))
		userRows.WriteString(`</td><td>`)
		userRows.WriteString(ui.EscapeHTML(stringField(user, "arn")))
		userRows.WriteString(`</td></tr>`)
	}
	var roleRows strings.Builder
	for _, role := range roles {
		roleRows.WriteString(`<tr><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "role_name")))
		roleRows.WriteString(`</td><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "role_id")))
		roleRows.WriteString(`</td><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "description")))
		roleRows.WriteString(`</td><td>`)
		roleRows.WriteString(ui.EscapeHTML(stringField(role, "arn")))
		roleRows.WriteString(`</td></tr>`)
	}
	return `<div class="inspector-section">
  <h2>IAM Users (` + fmt.Sprint(len(users)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>User</th><th>User ID</th><th>Access Keys</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(userRows.String(), 4, "No users") + `</tbody>
  </table>
</div>
<div class="inspector-section">
  <h2>IAM Roles (` + fmt.Sprint(len(roles)) + `)</h2>
  <table class="inspector-table">
    <thead><tr><th>Role</th><th>Role ID</th><th>Description</th><th>ARN</th></tr></thead>
    <tbody>` + rowsOrEmpty(roleRows.String(), 4, "No roles") + `</tbody>
  </table>
</div>`
}

func rowsOrEmpty(rows string, columns int, label string) string {
	if rows != "" {
		return rows
	}
	return `<tr><td colspan="` + fmt.Sprint(columns) + `"><div class="inspector-empty">` + ui.EscapeHTML(label) + `</div></td></tr>`
}

func stringField(record corestore.Record, name string) string {
	switch value := record[name].(type) {
	case string:
		return value
	case int:
		return fmt.Sprint(value)
	case int64:
		return fmt.Sprint(value)
	case float64:
		return fmt.Sprint(value)
	default:
		return ""
	}
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
}

func yesNo(value bool) string {
	if value {
		return "Yes"
	}
	return "No"
}

func accessKeyCount(record corestore.Record) int {
	switch value := record["access_keys"].(type) {
	case []corestore.Record:
		return len(value)
	case []any:
		return len(value)
	case []map[string]any:
		return len(value)
	default:
		return 0
	}
}
