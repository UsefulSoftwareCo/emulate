package vercel

import (
	"net/http"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerAPIKeyRoutes(router *corehttp.Router) {
	router.Post("/v1/api-keys", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		name := stringValue(body["name"])
		if name == "" {
			name = "API Key"
		}
		teamID := c.Query("teamId")
		var teamValue any
		if teamID != "" {
			teamValue = teamID
		}
		tokenString := "vercel_api_" + generateSecret()
		uid := generateUID("ak")
		s.store.APIKeys.Insert(corestore.Record{
			"uid":         uid,
			"name":        name,
			"teamId":      teamValue,
			"userId":      stringField(user, "uid"),
			"tokenString": tokenString,
		})
		c.JSON(http.StatusOK, map[string]any{
			"apiKeyString": tokenString,
			"apiKey": map[string]any{
				"id":        uid,
				"name":      name,
				"teamId":    teamValue,
				"createdAt": nowMillis(),
			},
		})
	})

	router.Get("/v1/api-keys", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		teamID := c.Query("teamId")
		keys := make([]map[string]any, 0)
		for _, key := range s.store.APIKeys.FindBy("userId", stringField(user, "uid")) {
			if teamID != "" && stringField(key, "teamId") != teamID {
				continue
			}
			keys = append(keys, map[string]any{
				"id":        stringField(key, "uid"),
				"name":      stringField(key, "name"),
				"teamId":    key["teamId"],
				"createdAt": timeMillisField(key, "created_at"),
			})
		}
		c.JSON(http.StatusOK, map[string]any{"keys": keys})
	})

	router.Delete("/v1/api-keys/:keyId", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		key := firstRecord(s.store.APIKeys.FindBy("uid", c.Param("keyId")))
		if key == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "API key not found")
			return
		}
		if stringField(key, "userId") != stringField(user, "uid") {
			writeVercelError(c, http.StatusForbidden, "forbidden", "Not authorized to delete this API key")
			return
		}
		s.store.APIKeys.Delete(intField(key, "id"))
		c.JSON(http.StatusOK, map[string]any{})
	})
}
