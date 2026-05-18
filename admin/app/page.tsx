/**
 * Root → /queue redirect.
 *
 * The admin app has no actual home page; signing in lands you on the review
 * queue. For unauthenticated users, the middleware intercepts and bounces
 * to /sign-in.
 */
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/queue');
}
