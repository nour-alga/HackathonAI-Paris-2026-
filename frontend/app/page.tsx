// Page de test uniquement — le vrai frontend est développé séparément
export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-red-500 mb-4">KOVER.IA</h1>
        <p className="text-gray-400 mb-8">Tainted Flow Detection — Test Interface</p>
        <div className="flex gap-4 justify-center">
          <a href="/dashboard" className="px-6 py-3 bg-red-600 rounded-lg hover:bg-red-700">
            Dashboard
          </a>
          <a href="/replay" className="px-6 py-3 bg-gray-700 rounded-lg hover:bg-gray-600">
            Replay Euler Hack
          </a>
        </div>
      </div>
    </main>
  )
}
