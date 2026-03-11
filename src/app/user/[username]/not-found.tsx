import Link from "next/link";

export default function NotFound() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      {/* Navigation */}
      <div className="mb-8">
        <Link 
          href="/" 
          className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Stela
        </Link>
      </div>

      {/* Error State */}
      <div className="text-center py-16">
        <div className="mb-6">
          <svg 
            className="w-16 h-16 mx-auto text-zinc-600 mb-4" 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={1.5} 
              d="M9.172 16.172a4 4 0 015.656 0M9 12h6m-6 0a9 9 0 1118 0 9 9 0 01-18 0z" 
            />
          </svg>
          <h1 className="text-2xl font-bold text-zinc-300 mb-2">Account Not Found</h1>
          <p className="text-zinc-500 mb-6">
            This account could not be found, may be protected, or has been suspended.
          </p>
        </div>

        <div className="space-y-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Search for Another Account
          </Link>
        </div>

        {/* Help Text */}
        <div className="mt-12 pt-8 border-t border-zinc-800">
          <h3 className="text-lg font-semibold mb-4">Common Reasons</h3>
          <div className="space-y-3 text-sm text-zinc-400 text-left max-w-md mx-auto">
            <div className="flex gap-3">
              <span className="text-zinc-600">•</span>
              <span>Account username was typed incorrectly</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600">•</span>
              <span>Account is protected (private)</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600">•</span>
              <span>Account has been suspended or deleted</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-600">•</span>
              <span>Account does not exist on X</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}