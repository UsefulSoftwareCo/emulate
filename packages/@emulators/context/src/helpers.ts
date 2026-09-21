/** Domains Context refuses to resolve: a person's mailbox is not a company.
 *  Real Context rejects free consumer and disposable mail providers before it
 *  ever looks for a brand, so the emulator has to reject them too. Otherwise a
 *  test seeded with a gmail.com brand would pass here and fail in production. */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
]);

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwaway.email",
  "trashmail.com",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
]);

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!
    .split("?")[0]!;
}

/** Returns the domain part of an email address, or null when it is not one. */
export function domainFromEmail(email: string): string | null {
  const at = email.trim().lastIndexOf("@");
  if (at <= 0 || at === email.trim().length - 1) return null;
  const domain = normalizeDomain(email.trim().slice(at + 1));
  return domain.includes(".") ? domain : null;
}

export function isPersonalDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain) || DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
