/**
 * Reddit closed self-serve API apps in November 2025, and automated posting
 * is the fastest way to get a new account shadowbanned. So the studio does
 * not post to Reddit for you. It opens the submit page with the title (and,
 * where Reddit still honours it, the body) filled in, and copies the body to
 * your clipboard. You press Post.
 */
export function redditSubmitUrl(subreddit: string, title: string, body: string): string {
  const sub = subreddit.replace(/^\/?r\//i, '').trim();
  const q = new URLSearchParams({ selftext: 'true', title, text: body });
  return `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?${q.toString()}`;
}
