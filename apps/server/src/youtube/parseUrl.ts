export interface ParsedYoutubeUrl {
  valid: boolean;
  originalUrl: string | null;
  normalizedUrl: string | null;
  videoId: string | null;
  reason?: string;
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export function parseYoutubeUrl(input: string | undefined): ParsedYoutubeUrl {
  const value = input?.trim();
  if (!value) {
    return {
      valid: false,
      originalUrl: null,
      normalizedUrl: null,
      videoId: null,
      reason: "No URL provided"
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      valid: false,
      originalUrl: value,
      normalizedUrl: null,
      videoId: null,
      reason: "URL is not valid"
    };
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return {
      valid: false,
      originalUrl: value,
      normalizedUrl: null,
      videoId: null,
      reason: "URL is not a supported YouTube host"
    };
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return {
      valid: false,
      originalUrl: value,
      normalizedUrl: null,
      videoId: null,
      reason: "Could not extract a YouTube video id"
    };
  }

  return {
    valid: true,
    originalUrl: value,
    normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId
  };
}

function extractVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();

  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").trim();
    return isValidVideoId(id) ? id : null;
  }

  const fromQuery = url.searchParams.get("v")?.trim() ?? "";
  if (isValidVideoId(fromQuery)) {
    return fromQuery;
  }

  const pathMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (pathMatch && isValidVideoId(pathMatch[1])) {
    return pathMatch[1];
  }

  return null;
}

function isValidVideoId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(value);
}
