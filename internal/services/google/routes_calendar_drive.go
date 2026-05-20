package google

import (
	"encoding/base64"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
)

func (s *Service) registerCalendarRoutes(router *corehttp.Router) {
	router.Get("/calendar/v3/users/:userId/calendarList", s.handleCalendarList)
	router.Get("/calendar/v3/calendars/:calendarId/events", s.handleListCalendarEvents)
	router.Post("/calendar/v3/calendars/:calendarId/events", s.handleCreateCalendarEvent)
	router.Delete("/calendar/v3/calendars/:calendarId/events/:eventId", s.handleDeleteCalendarEvent)
	router.Post("/calendar/v3/freeBusy", s.handleFreeBusy)
}

func (s *Service) registerDriveRoutes(router *corehttp.Router) {
	router.Get("/drive/v3/files", s.handleListDriveFiles)
	router.Post("/drive/v3/files", s.handleCreateDriveFile)
	router.Post("/upload/drive/v3/files", s.handleCreateDriveFile)
	router.Get("/drive/v3/files/:fileId", s.handleGetDriveFile)
	router.Patch("/drive/v3/files/:fileId", s.handleUpdateDriveFile)
	router.Put("/drive/v3/files/:fileId", s.handleUpdateDriveFile)
}

func (s *Service) handleCalendarList(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	calendars := s.listCalendars(email)
	items := make([]map[string]any, 0, len(calendars))
	for _, calendar := range calendars {
		items = append(items, formatCalendarResource(calendar))
	}
	c.JSON(http.StatusOK, map[string]any{"kind": "calendar#calendarList", "items": items})
}

func (s *Service) handleListCalendarEvents(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	calendar := s.getCalendarByID(email, c.Param("calendarId"))
	if calendar == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	events := s.listCalendarEvents(email, stringField(calendar, "google_id"), c.Request.URL.Query())
	offset := parseOffset(c.Query("pageToken"))
	limit := normalizeLimit(c.Query("maxResults"), 10, 250)
	page := pageRecords(events, offset, limit)
	items := make([]map[string]any, 0, len(page))
	for _, event := range page {
		items = append(items, formatCalendarEventResource(s, event))
	}
	body := map[string]any{"kind": "calendar#events", "items": items}
	if offset+limit < len(events) {
		body["nextPageToken"] = strconv.Itoa(offset + limit)
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleCreateCalendarEvent(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	calendar := s.getCalendarByID(email, c.Param("calendarId"))
	if calendar == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	body := parseJSONBody(c.Request)
	start := mapValue(body["start"])
	end := mapValue(body["end"])
	if stringValue(start["dateTime"]) == "" && stringValue(start["date"]) == "" {
		googleAPIError(c, http.StatusBadRequest, "Event start and end are required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	if stringValue(end["dateTime"]) == "" && stringValue(end["date"]) == "" {
		googleAPIError(c, http.StatusBadRequest, "Event start and end are required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	attendees := []map[string]any{}
	for _, attendee := range recordSliceValue(body["attendees"]) {
		emailValue := stringValue(attendee["email"])
		if emailValue == "" {
			continue
		}
		attendees = append(attendees, map[string]any{
			"email":           emailValue,
			"display_name":    nullableString(stringValue(attendee["displayName"])),
			"response_status": nullableString(stringValue(attendee["responseStatus"])),
			"organizer":       attendee["organizer"] == true,
			"self":            attendee["self"] == true,
		})
	}
	conferenceData := mapValue(body["conferenceData"])
	entryPoints := []map[string]any{}
	for _, entry := range recordSliceValue(conferenceData["entryPoints"]) {
		uri := stringValue(entry["uri"])
		if uri == "" {
			continue
		}
		entryPoints = append(entryPoints, map[string]any{
			"entry_point_type": firstNonEmpty(stringValue(entry["entryPointType"]), "video"),
			"uri":              uri,
			"label":            nullableString(stringValue(entry["label"])),
		})
	}
	event := s.createCalendarEventRecord(calendarEventInput{
		UserEmail:             email,
		CalendarGoogleID:      stringField(calendar, "google_id"),
		Status:                firstNonEmpty(stringValue(body["status"]), "confirmed"),
		Summary:               stringValue(body["summary"]),
		Description:           nullableString(stringValue(body["description"])),
		Location:              nullableString(stringValue(body["location"])),
		StartDateTime:         stringValue(start["dateTime"]),
		StartDate:             stringValue(start["date"]),
		EndDateTime:           stringValue(end["dateTime"]),
		EndDate:               stringValue(end["date"]),
		Attendees:             attendees,
		ConferenceEntryPoints: entryPoints,
		HangoutLink:           nullableString(firstNonEmpty(stringValue(body["hangoutLink"]), firstVideoURI(entryPoints))),
		Transparency:          nullableString(stringValue(body["transparency"])),
	})
	c.JSON(http.StatusOK, formatCalendarEventResource(s, event))
}

func (s *Service) handleDeleteCalendarEvent(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	event := s.getCalendarEventByID(email, c.Param("calendarId"), c.Param("eventId"))
	if event == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	s.store.CalendarEvents.Delete(intField(event, "id"))
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleFreeBusy(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	timeMin := stringValue(body["timeMin"])
	timeMax := stringValue(body["timeMax"])
	if timeMin == "" || timeMax == "" {
		googleAPIError(c, http.StatusBadRequest, "timeMin and timeMax are required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	c.JSON(http.StatusOK, buildFreeBusyResponse(s, email, timeMin, timeMax, recordSliceValue(body["items"])))
}

func (s *Service) handleListDriveFiles(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	files := s.listDriveItems(email, c.Request.URL.Query())
	offset := parseOffset(c.Query("pageToken"))
	limit := normalizeLimit(c.Query("pageSize"), 100, 1000)
	page := pageRecords(files, offset, limit)
	items := make([]map[string]any, 0, len(page))
	for _, item := range page {
		items = append(items, formatDriveItemResource(item))
	}
	body := map[string]any{"kind": "drive#fileList", "files": items}
	if offset+limit < len(files) {
		body["nextPageToken"] = strconv.Itoa(offset + limit)
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleCreateDriveFile(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	contentType := c.Header("Content-Type")
	var body map[string]any
	mimeType := ""
	var media []byte
	if strings.Contains(contentType, "multipart/related") {
		raw, _ := io.ReadAll(c.Request.Body)
		body, mimeType, media = parseDriveMultipartUpload(contentType, raw)
	} else if strings.HasPrefix(c.Request.URL.Path, "/upload/drive/v3/files") && c.Query("uploadType") == "media" {
		media, _ = io.ReadAll(c.Request.Body)
		mimeType = driveUploadContentType(contentType)
		body = map[string]any{}
	} else {
		body = parseJSONBody(c.Request)
	}
	parents := getStringArray(body, "parents")
	if len(parents) == 0 {
		parents = []string{"root"}
	}
	if mimeType == "" {
		mimeType = firstNonEmpty(stringValue(body["mimeType"]), "application/octet-stream")
	}
	var data any
	var size *int
	if media != nil {
		data = base64URLString(media)
		size = intPtr(len(media))
	}
	item := s.createDriveItemRecord(driveItemInput{
		UserEmail:       email,
		Name:            firstNonEmpty(stringValue(body["name"]), "Untitled"),
		MIMEType:        mimeType,
		ParentGoogleIDs: parents,
		Data:            data,
		Size:            size,
	})
	c.JSON(http.StatusOK, formatDriveItemResource(item))
}

func driveUploadContentType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err == nil && mediaType != "" {
		return mediaType
	}
	if strings.TrimSpace(contentType) != "" {
		return strings.TrimSpace(contentType)
	}
	return "application/octet-stream"
}

func (s *Service) handleGetDriveFile(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	item := s.getDriveItemByID(email, c.Param("fileId"))
	if item == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	if c.Query("alt") == "media" {
		data := stringField(item, "data")
		if data == "" {
			c.Binary(http.StatusOK, stringField(item, "mime_type"), nil)
			return
		}
		raw, err := base64.RawURLEncoding.DecodeString(data)
		if err != nil {
			raw = nil
		}
		c.Binary(http.StatusOK, stringField(item, "mime_type"), raw)
		return
	}
	c.JSON(http.StatusOK, formatDriveItemResource(item))
}

func (s *Service) handleUpdateDriveFile(c *corehttp.Context) {
	email, ok := s.authenticatedEmail(c)
	if !ok {
		return
	}
	item := s.getDriveItemByID(email, c.Param("fileId"))
	if item == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	if c.Request.Method == http.MethodPut {
		media, _ := io.ReadAll(c.Request.Body)
		updated := s.updateDriveItemContent(item, driveUploadContentType(c.Header("Content-Type")), media)
		c.JSON(http.StatusOK, formatDriveItemResource(updated))
		return
	}
	body := parseJSONBody(c.Request)
	addParents := splitCSV(c.Query("addParents"))
	removeParents := splitCSV(c.Query("removeParents"))
	updated := s.updateDriveItemRecord(item, addParents, removeParents, stringValue(body["name"]))
	c.JSON(http.StatusOK, formatDriveItemResource(updated))
}

func firstVideoURI(entries []map[string]any) string {
	for _, entry := range entries {
		if stringValue(entry["entry_point_type"]) == "video" {
			return stringValue(entry["uri"])
		}
	}
	return ""
}

func splitCSV(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
