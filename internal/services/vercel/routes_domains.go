package vercel

import (
	"net/http"
	"net/url"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerDomainRoutes(router *corehttp.Router) {
	router.Post("/v10/projects/:idOrName/domains", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		nameRaw := strings.TrimSpace(stringValue(body["name"]))
		if nameRaw == "" {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Missing required field: name")
			return
		}
		name := normalizeDomainName(nameRaw)
		if s.findDomainInProject(stringField(project, "uid"), name) != nil {
			writeVercelError(c, http.StatusConflict, "domain_already_exists", "A domain with this name already exists on the project")
			return
		}
		redirect := parseNullableTrimmedString(body["redirect"])
		redirectStatusCode, valid := parseRedirectStatusCode(body["redirectStatusCode"])
		if !valid {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid redirectStatusCode")
			return
		}
		gitBranch := parseNullableString(body["gitBranch"])
		customEnvironmentID := parseNullableString(body["customEnvironmentId"])
		uid := generateUID("")
		verified := isVercelAppDomain(name)
		verification := []any{}
		if !verified {
			apex := extractApexName(name)
			verification = append(verification, map[string]any{
				"type":   "TXT",
				"domain": "_vercel." + apex,
				"value":  "vc-domain-verify=" + name + "," + uid,
				"reason": "Add the TXT record above to verify domain ownership",
			})
		}
		domain := s.store.Domains.Insert(corestore.Record{
			"uid":                 uid,
			"projectId":           stringField(project, "uid"),
			"name":                name,
			"apexName":            extractApexName(name),
			"redirect":            redirect,
			"redirectStatusCode":  redirectStatusCode,
			"gitBranch":           gitBranch,
			"customEnvironmentId": customEnvironmentID,
			"verified":            verified,
			"verification":        verification,
		})
		c.JSON(http.StatusOK, formatDomain(domain))
	})

	router.Get("/v9/projects/:idOrName/domains", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		list := s.store.Domains.FindBy("projectId", stringField(project, "uid"))
		items, page := applyPagination(list, parsePagination(c))
		out := make([]map[string]any, 0, len(items))
		for _, domain := range items {
			out = append(out, formatDomain(domain))
		}
		c.JSON(http.StatusOK, map[string]any{"domains": out, "pagination": page})
	})

	router.Get("/v9/projects/:idOrName/domains/:domain", func(c *corehttp.Context) {
		s.handleGetDomain(c)
	})
	router.Post("/v9/projects/:idOrName/domains/:domain/verify", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		existing := s.findDomainInProject(stringField(project, "uid"), decodeDomainParam(c.Param("domain")))
		if existing == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Domain not found")
			return
		}
		updated, ok := s.store.Domains.Update(intField(existing, "id"), corestore.Record{"verified": true, "verification": []any{}})
		if !ok {
			writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update domain")
			return
		}
		c.JSON(http.StatusOK, formatDomain(updated))
	})
	router.Patch("/v9/projects/:idOrName/domains/:domain", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		existing := s.findDomainInProject(stringField(project, "uid"), decodeDomainParam(c.Param("domain")))
		if existing == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Domain not found")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		patch := corestore.Record{}
		if value, exists := body["gitBranch"]; exists {
			patch["gitBranch"] = parseNullableStringPatch(value, existing["gitBranch"])
		}
		if value, exists := body["redirect"]; exists {
			patch["redirect"] = parseNullableTrimmedStringPatch(value, existing["redirect"])
		}
		if value, exists := body["redirectStatusCode"]; exists {
			code, valid := parseRedirectStatusCode(value)
			if !valid {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid redirectStatusCode")
				return
			}
			patch["redirectStatusCode"] = code
		}
		if value, exists := body["customEnvironmentId"]; exists {
			patch["customEnvironmentId"] = parseNullableStringPatch(value, existing["customEnvironmentId"])
		}
		updated, ok := s.store.Domains.Update(intField(existing, "id"), patch)
		if !ok {
			writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update domain")
			return
		}
		c.JSON(http.StatusOK, formatDomain(updated))
	})
	router.Delete("/v9/projects/:idOrName/domains/:domain", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		existing := s.findDomainInProject(stringField(project, "uid"), decodeDomainParam(c.Param("domain")))
		if existing == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Domain not found")
			return
		}
		s.store.Domains.Delete(intField(existing, "id"))
		c.JSON(http.StatusOK, map[string]any{})
	})
}

func (s *Service) handleGetDomain(c *corehttp.Context) {
	scoped, ok := s.resolveScope(c)
	if !ok {
		writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
		return
	}
	project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
	if project == nil {
		writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
		return
	}
	existing := s.findDomainInProject(stringField(project, "uid"), decodeDomainParam(c.Param("domain")))
	if existing == nil {
		writeVercelError(c, http.StatusNotFound, "not_found", "Domain not found")
		return
	}
	c.JSON(http.StatusOK, formatDomain(existing))
}

func extractApexName(domain string) string {
	parts := strings.Split(strings.ToLower(domain), ".")
	compact := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			compact = append(compact, part)
		}
	}
	if len(compact) == 0 {
		return domain
	}
	if len(compact) == 1 {
		return compact[0]
	}
	return compact[len(compact)-2] + "." + compact[len(compact)-1]
}

func isVercelAppDomain(domain string) bool {
	domain = strings.ToLower(domain)
	return domain == "vercel.app" || strings.HasSuffix(domain, ".vercel.app")
}

func normalizeDomainName(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

func parseRedirectStatusCode(raw any) (any, bool) {
	if raw == nil {
		return nil, true
	}
	number, ok := numberToInt(raw)
	if !ok {
		return nil, false
	}
	switch number {
	case 301, 302, 307, 308:
		return number, true
	default:
		return nil, false
	}
}

func numberToInt(raw any) (int, bool) {
	switch value := raw.(type) {
	case int:
		return value, true
	case float64:
		next := int(value)
		return next, float64(next) == value
	default:
		return 0, false
	}
}

func (s *Service) findDomainInProject(projectID string, domainName string) corestore.Record {
	normalized := normalizeDomainName(domainName)
	for _, domain := range s.store.Domains.FindBy("projectId", projectID) {
		if normalizeDomainName(stringField(domain, "name")) == normalized {
			return domain
		}
	}
	return nil
}

func decodeDomainParam(raw string) string {
	decoded, err := url.QueryUnescape(raw)
	if err != nil {
		return raw
	}
	return decoded
}

func parseNullableString(raw any) any {
	if raw == nil {
		return nil
	}
	if str, ok := raw.(string); ok {
		return str
	}
	return nil
}

func parseNullableTrimmedString(raw any) any {
	if raw == nil {
		return nil
	}
	if str, ok := raw.(string); ok {
		str = strings.TrimSpace(str)
		if str == "" {
			return nil
		}
		return str
	}
	return nil
}

func parseNullableStringPatch(raw any, existing any) any {
	if raw == nil {
		return nil
	}
	if str, ok := raw.(string); ok {
		return str
	}
	return existing
}

func parseNullableTrimmedStringPatch(raw any, existing any) any {
	if raw == nil {
		return nil
	}
	if str, ok := raw.(string); ok {
		str = strings.TrimSpace(str)
		if str == "" {
			return nil
		}
		return str
	}
	return existing
}
