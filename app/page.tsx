import Link from "next/link";

export default function HomePage() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-3xl font-bold text-gray-900 mb-4">PropManage AI</h1>
      <p className="text-gray-600 mb-8">AI-first property management platform</p>
      <Link
        href="/tickets"
        className="inline-block bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
      >
        View Tickets
      </Link>
    </div>
  );
}
