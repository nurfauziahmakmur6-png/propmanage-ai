import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PropManage AI",
  description: "AI-first property management platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        <nav className="bg-white border-b border-gray-200 px-6 py-3">
          <a href="/" className="text-lg font-semibold text-gray-900">
            PropManage AI
          </a>
          <span className="ml-6 text-sm text-gray-500">
            <a href="/tickets" className="hover:text-gray-900">
              Tickets
            </a>
            <a href="/documents" className="ml-4 hover:text-gray-900">
              Documents
            </a>
          </span>
        </nav>
        <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
