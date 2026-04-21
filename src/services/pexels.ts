/**
 * Pexels stock-video fallback. Free up to 20k requests/month; attribution
 * required per their ToS (display "Videos by Pexels" next to the result).
 *
 * Only used when the user opts into the "stock" duration strategy, or when
 * their prompt matches our preset allowlist.
 */

export interface PexelsVideo {
  id: number;
  url: string;      // mp4 url
  width: number;
  height: number;
}

export const STOCK_PROMPT_MAP: Record<string, string> = {
  cosmic: "galaxy nebula space",
  mystical: "aurora northern lights",
  spiritual: "stars night sky",
};

export async function searchPexels(
  env: CloudflareEnv,
  query: string,
): Promise<PexelsVideo | null> {
  if (!env.PEXELS_API_KEY) return null;

  const url =
    `https://api.pexels.com/videos/search?per_page=5&orientation=portrait&size=medium&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Authorization: env.PEXELS_API_KEY },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    videos?: Array<{
      id: number;
      video_files: Array<{ link: string; width: number; height: number; file_type: string }>;
    }>;
  };

  for (const video of body.videos ?? []) {
    const mp4 = video.video_files.find(
      (f) => f.file_type === "video/mp4" && f.height >= 1280,
    );
    if (mp4) return { id: video.id, url: mp4.link, width: mp4.width, height: mp4.height };
  }
  return null;
}
