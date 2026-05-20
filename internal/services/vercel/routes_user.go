package vercel

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerUserRoutes(router *corehttp.Router) {
	router.Get("/registration", func(c *corehttp.Context) {
		c.JSON(http.StatusOK, map[string]any{"registration": false})
	})

	router.Get("/v2/user", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		c.JSON(http.StatusOK, map[string]any{"user": formatUser(user)})
	})

	router.Patch("/v2/user", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		patch := corestore.Record{}
		if value, exists := body["name"]; exists {
			if value == nil {
				patch["name"] = nil
			} else if name, ok := value.(string); ok {
				patch["name"] = name
			}
		}
		if value, exists := body["email"]; exists {
			if email, ok := value.(string); ok {
				patch["email"] = email
			}
		}
		updated, ok := s.store.Users.Update(intField(user, "id"), patch)
		if !ok {
			writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update user")
			return
		}
		c.JSON(http.StatusOK, map[string]any{"user": formatUser(updated)})
	})

	router.Get("/v2/teams", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		memberships := s.store.TeamMembers.FindBy("userId", stringField(user, "uid"))
		teams := make([]corestore.Record, 0, len(memberships))
		for _, membership := range memberships {
			team := firstRecord(s.store.Teams.FindBy("uid", stringField(membership, "teamId")))
			if team != nil {
				teams = append(teams, team)
			}
		}
		if c.Query("teamId") != "" || c.Query("slug") != "" {
			scoped, ok := s.resolveScope(c)
			if !ok || scoped.Team == nil {
				writeVercelError(c, http.StatusNotFound, "not_found", "Team not found")
				return
			}
			filtered := teams[:0]
			for _, team := range teams {
				if stringField(team, "uid") == stringField(scoped.Team, "uid") {
					filtered = append(filtered, team)
				}
			}
			teams = filtered
		}
		items, page := applyPagination(teams, parsePagination(c))
		out := make([]map[string]any, 0, len(items))
		for _, team := range items {
			member := s.getTeamMember(stringField(team, "uid"), stringField(user, "uid"))
			out = append(out, formatTeamForViewer(team, member))
		}
		c.JSON(http.StatusOK, map[string]any{"teams": out, "pagination": page})
	})

	router.Post("/v2/teams", func(c *corehttp.Context) {
		creator, ok := s.currentUser(c)
		if !ok {
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		slug := strings.TrimSpace(stringValue(body["slug"]))
		if slug == "" {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Missing required field: slug")
			return
		}
		if firstRecord(s.store.Teams.FindBy("slug", slug)) != nil {
			writeVercelError(c, http.StatusConflict, "team_slug_already_exists", "A team with this slug already exists")
			return
		}
		name := strings.TrimSpace(stringValue(body["name"]))
		if name == "" {
			name = slug
		}
		team := s.store.Teams.Insert(defaultTeamRecord(slug, name, nil, stringField(creator, "uid"), "hobby"))
		s.store.TeamMembers.Insert(corestore.Record{
			"teamId":     stringField(team, "uid"),
			"userId":     stringField(creator, "uid"),
			"role":       "OWNER",
			"confirmed":  true,
			"joinedFrom": "cli",
		})
		c.JSON(http.StatusOK, map[string]any{"team": formatTeamForViewer(team, s.getTeamMember(stringField(team, "uid"), stringField(creator, "uid")))})
	})

	router.Get("/v2/teams/:teamId", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		team := s.findTeamByIDOrSlug(c.Param("teamId"))
		if team == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Team not found")
			return
		}
		c.JSON(http.StatusOK, map[string]any{"team": formatTeamForViewer(team, s.getTeamMember(stringField(team, "uid"), stringField(user, "uid")))})
	})

	router.Patch("/v2/teams/:teamId", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		team := s.findTeamByIDOrSlug(c.Param("teamId"))
		if team == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Team not found")
			return
		}
		member := s.getTeamMember(stringField(team, "uid"), stringField(user, "uid"))
		if member == nil || stringField(member, "role") != "OWNER" {
			writeVercelError(c, http.StatusForbidden, "forbidden", "Insufficient permissions to update this team")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		patch := corestore.Record{}
		if name, ok := body["name"].(string); ok {
			patch["name"] = name
		}
		if value, exists := body["description"]; exists {
			if value == nil {
				patch["description"] = nil
			} else if description, ok := value.(string); ok {
				patch["description"] = description
			}
		}
		if rawSlug, ok := body["slug"].(string); ok {
			nextSlug := strings.TrimSpace(rawSlug)
			if nextSlug != "" && nextSlug != stringField(team, "slug") {
				taken := firstRecord(s.store.Teams.FindBy("slug", nextSlug))
				if taken != nil && intField(taken, "id") != intField(team, "id") {
					writeVercelError(c, http.StatusConflict, "team_slug_already_exists", "A team with this slug already exists")
					return
				}
				patch["slug"] = nextSlug
			}
		}
		updated, ok := s.store.Teams.Update(intField(team, "id"), patch)
		if !ok {
			writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update team")
			return
		}
		c.JSON(http.StatusOK, map[string]any{"team": formatTeamForViewer(updated, s.getTeamMember(stringField(updated, "uid"), stringField(user, "uid")))})
	})

	router.Get("/v2/teams/:teamId/members", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		team := s.findTeamByIDOrSlug(c.Param("teamId"))
		if team == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Team not found")
			return
		}
		if s.getTeamMember(stringField(team, "uid"), stringField(user, "uid")) == nil {
			writeVercelError(c, http.StatusForbidden, "forbidden", "Not a member of this team")
			return
		}
		members := s.store.TeamMembers.FindBy("teamId", stringField(team, "uid"))
		items, page := applyPagination(members, parsePagination(c))
		out := make([]map[string]any, 0, len(items))
		for _, member := range items {
			out = append(out, s.formatMemberRow(member))
		}
		c.JSON(http.StatusOK, map[string]any{"members": out, "pagination": page})
	})

	router.Post("/v2/teams/:teamId/members", func(c *corehttp.Context) {
		actor, ok := s.currentUser(c)
		if !ok {
			return
		}
		team := s.findTeamByIDOrSlug(c.Param("teamId"))
		if team == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Team not found")
			return
		}
		actorMember := s.getTeamMember(stringField(team, "uid"), stringField(actor, "uid"))
		if actorMember == nil || stringField(actorMember, "role") != "OWNER" {
			writeVercelError(c, http.StatusForbidden, "forbidden", "Insufficient permissions to add members")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		email := strings.TrimSpace(stringValue(body["email"]))
		uid := strings.TrimSpace(stringValue(body["uid"]))
		var target corestore.Record
		if uid != "" {
			target = firstRecord(s.store.Users.FindBy("uid", uid))
		} else if email != "" {
			target = firstRecord(s.store.Users.FindBy("email", email))
		} else {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Provide uid or email")
			return
		}
		if target == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "User not found")
			return
		}
		role := parseTeamRole(body["role"], "MEMBER")
		if role == "" {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid role")
			return
		}
		if s.getTeamMember(stringField(team, "uid"), stringField(target, "uid")) != nil {
			writeVercelError(c, http.StatusConflict, "member_already_exists", "User is already a member of this team")
			return
		}
		joinedFrom := "invite"
		if email != "" {
			joinedFrom = "email"
		}
		member := s.store.TeamMembers.Insert(corestore.Record{
			"teamId":     stringField(team, "uid"),
			"userId":     stringField(target, "uid"),
			"role":       role,
			"confirmed":  true,
			"joinedFrom": joinedFrom,
		})
		c.JSON(http.StatusOK, map[string]any{"member": s.formatMemberRow(member)})
	})
}

func (s *Service) findTeamByIDOrSlug(idOrSlug string) corestore.Record {
	if team := firstRecord(s.store.Teams.FindBy("uid", idOrSlug)); team != nil {
		return team
	}
	return firstRecord(s.store.Teams.FindBy("slug", idOrSlug))
}

func (s *Service) getTeamMember(teamID string, userID string) corestore.Record {
	for _, member := range s.store.TeamMembers.FindBy("teamId", teamID) {
		if stringField(member, "userId") == userID {
			return member
		}
	}
	return nil
}

func formatTeamForViewer(team corestore.Record, member corestore.Record) map[string]any {
	out := formatTeam(team)
	if member != nil {
		out["membership"] = map[string]any{
			"confirmed": boolField(member, "confirmed"),
			"role":      stringField(member, "role"),
		}
	} else {
		out["membership"] = map[string]any{
			"confirmed": false,
			"role":      "VIEWER",
		}
	}
	return out
}

func (s *Service) formatMemberRow(member corestore.Record) map[string]any {
	user := firstRecord(s.store.Users.FindBy("uid", stringField(member, "userId")))
	var userOut any
	if user != nil {
		userOut = formatUser(user)
	}
	return map[string]any{
		"id":         stringValue(intField(member, "id")),
		"role":       stringField(member, "role"),
		"confirmed":  boolField(member, "confirmed"),
		"joinedFrom": stringField(member, "joinedFrom"),
		"user":       userOut,
	}
}

func parseTeamRole(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	role, ok := value.(string)
	if !ok {
		return ""
	}
	switch role {
	case "OWNER", "MEMBER", "DEVELOPER", "VIEWER":
		return role
	default:
		return ""
	}
}
