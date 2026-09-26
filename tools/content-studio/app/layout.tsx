import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Overload Studio',
  description: 'Ideas, posts and publishing for X, LinkedIn and Reddit.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
