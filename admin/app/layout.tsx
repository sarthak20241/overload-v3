/**
 * Root layout for the entire admin site. Wraps in ClerkProvider so
 * `auth()` / `<UserButton>` / `<SignedIn>` work anywhere downstream.
 *
 * The middleware (see /middleware.ts) protects every route except
 * /, /sign-in, /sign-up, /no-access — so by the time a page renders, the
 * user is signed in (or in one of the public routes). The per-route admin
 * check (calling is_admin Postgres RPC) happens inside (admin)/layout.tsx.
 */
import type { Metadata } from "next";
import { ClerkProvider } from '@clerk/nextjs';
import "./globals.css";

export const metadata: Metadata = {
  title: "Overload Admin",
  description: "Research-KB review and admin tools for the Overload AI Coach",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: '#c8ff00',
          colorBackground: '#0a0a0a',
          colorText: '#ededed',
          colorInputBackground: '#161616',
          colorInputText: '#ededed',
        },
      }}
    >
      <html lang="en">
        <body className="bg-bg text-fg antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
