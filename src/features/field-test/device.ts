/**
 * Device and browser description for field-test reports, from the user
 * agent. User agents are unreliable on phones, so the raw string is always
 * kept and the caveats are stated:
 * - every iPhone browser uses Safari's engine (WebKit), whatever its name;
 * - recent Safari freezes the iOS version in the user agent, so the real iOS
 *   version must be read from Settings → General → About;
 * - Chrome on Android hides the phone model ("K") unless it shares User-Agent
 *   Client Hints, which are added separately when available.
 */
export type ParsedAgent = {
  os: "iOS" | "Android" | "Windows" | "macOS" | "Linux" | "ChromeOS" | "other";
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
  notes: string[];
};

function version(match: RegExpMatchArray | null): string | null {
  return match?.[1] ? match[1].replace(/_/g, ".") : null;
}

export function parseUserAgent(ua: string): ParsedAgent {
  const notes: string[] = [];
  let os: ParsedAgent["os"] = "other";
  let osVersion: string | null = null;
  if (/iPhone|iPad|iPod/.test(ua)) {
    os = "iOS";
    osVersion = version(ua.match(/OS (\d+(?:_\d+)*) like Mac OS X/));
    notes.push("iOS version in the user agent may be frozen by Safari; read the real one in Settings → General → About.");
    notes.push("Every iPhone browser runs on Safari's engine (WebKit).");
  } else if (/Android/.test(ua)) {
    os = "Android";
    osVersion = version(ua.match(/Android (\d+(?:\.\d+)*)/));
    if (/Android 10; K\)/.test(ua)) notes.push("Chrome hides the model and Android version in the user agent; see model/platformVersion.");
  } else if (/CrOS/.test(ua)) {
    os = "ChromeOS";
  } else if (/Windows NT/.test(ua)) {
    os = "Windows";
    osVersion = version(ua.match(/Windows NT (\d+(?:\.\d+)*)/));
  } else if (/Mac OS X/.test(ua)) {
    os = "macOS";
    osVersion = version(ua.match(/Mac OS X (\d+(?:[._]\d+)*)/));
  } else if (/Linux/.test(ua)) {
    os = "Linux";
  }

  let browser = "other";
  let browserVersion: string | null = null;
  const pick = (name: string, pattern: RegExp) => {
    browser = name;
    browserVersion = version(ua.match(pattern));
  };
  if (/CriOS\//.test(ua)) pick("Chrome (iOS)", /CriOS\/([\d.]+)/);
  else if (/FxiOS\//.test(ua)) pick("Firefox (iOS)", /FxiOS\/([\d.]+)/);
  else if (/EdgiOS\//.test(ua)) pick("Edge (iOS)", /EdgiOS\/([\d.]+)/);
  else if (/SamsungBrowser\//.test(ua)) pick("Samsung Internet", /SamsungBrowser\/([\d.]+)/);
  else if (/Edg\//.test(ua)) pick("Edge", /Edg\/([\d.]+)/);
  else if (/Firefox\//.test(ua)) pick("Firefox", /Firefox\/([\d.]+)/);
  else if (/HeadlessChrome\//.test(ua)) pick("Headless Chrome", /HeadlessChrome\/([\d.]+)/);
  else if (/Chrome\//.test(ua)) pick("Chrome", /Chrome\/([\d.]+)/);
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) pick("Safari", /Version\/([\d.]+)/);
  else if (os === "iOS" && /AppleWebKit/.test(ua)) browser = "WebKit view (home-screen app or in-app browser)";
  return { os, osVersion, browser, browserVersion, notes };
}
