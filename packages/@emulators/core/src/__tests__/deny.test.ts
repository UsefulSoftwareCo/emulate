import { describe, expect, it } from "vitest";
import { oauthDenialUrl, renderDenyButton } from "../ui.js";

describe("renderDenyButton", () => {
  it("links back to the client with access_denied and the state in the query", () => {
    const html = renderDenyButton({ redirectUri: "http://127.0.0.1:9/cb?keep=1", state: "s 1" });
    const href = /href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:9/cb");
    expect(url.searchParams.get("keep")).toBe("1");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s 1");
    expect(url.searchParams.has("code")).toBe(false);
  });

  it("answers in the fragment when the request asked for it", () => {
    const url = new URL(oauthDenialUrl({ redirectUri: "http://127.0.0.1:9/cb", state: "s", responseMode: "fragment" }));
    expect(url.search).toBe("");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("error")).toBe("access_denied");
    expect(fragment.get("state")).toBe("s");
  });

  it("posts the error to the redirect URI for form_post", () => {
    const html = renderDenyButton({
      redirectUri: "https://app.example/cb",
      state: "s",
      responseMode: "form_post",
      extra: { iss: "https://issuer.example" },
    });
    expect(html).toContain('method="post" action="https://app.example/cb"');
    expect(html).toContain('name="error" value="access_denied"');
    expect(html).toContain('name="state" value="s"');
    expect(html).toContain('name="iss" value="https://issuer.example"');
  });

  it("renders nothing without a usable redirect URI", () => {
    expect(renderDenyButton({ redirectUri: "", state: "s" })).toBe("");
    expect(renderDenyButton({ redirectUri: "not a url", state: "s" })).toBe("");
  });
});
