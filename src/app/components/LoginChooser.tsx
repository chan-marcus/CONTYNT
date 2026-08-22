import { useEffect } from "react";
import { motion } from "motion/react";
import { ArrowRight, Store, Video } from "lucide-react";

// There are two portals behind one "Log in" button, and nothing on the marketing
// page tells us which one a visitor wants. Rather than guess, /login asks once.
// Anyone already signed in never sees this: App.tsx sends a stored session
// straight to its portal.
export function LoginChooser() {
  useEffect(() => { document.title = "CONTYNT | Sign In"; }, []);

  const OPTIONS = [
    {
      href: "/app",
      icon: Video,
      title: "I'm a creator",
      body: "Claim Features, submit Reels, and track what you have earned.",
    },
    {
      href: "/business",
      icon: Store,
      title: "I'm a business",
      body: "See your Reels, request creators, and manage your plan.",
    },
  ];

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      <header className="border-b border-white/10 px-5 py-4">
        <div className="max-w-sm mx-auto flex items-center justify-between">
          <a href="/" className="text-sm font-semibold tracking-[0.2em] hover:opacity-80 transition-opacity">C O N T Y N T</a>
          <span className="text-xs text-neutral-500">Sign In</span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-sm mx-auto px-5 py-12">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
          className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold leading-snug">Welcome back</h1>
            <p className="text-sm text-neutral-400 leading-relaxed">
              We will email you a 6 digit code.
            </p>
          </div>

          <div className="space-y-3">
            {OPTIONS.map(({ href, icon: Icon, title, body }) => (
              <a key={href} href={href}
                className="group flex items-start gap-3.5 w-full text-left px-4 py-4 rounded-2xl bg-white/5 border border-white/10 hover:border-white/30 hover:bg-white/[0.07] transition-all">
                <span className="inline-flex items-center justify-center w-10 h-10 shrink-0 rounded-xl bg-white/5 border border-white/10">
                  <Icon className="w-4.5 h-4.5 text-neutral-300" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-xs text-neutral-400 leading-relaxed mt-0.5">{body}</span>
                </span>
                <ArrowRight className="w-4 h-4 text-neutral-600 shrink-0 mt-3 group-hover:text-neutral-300 group-hover:translate-x-0.5 transition-all" />
              </a>
            ))}
          </div>

          <p className="text-xs text-neutral-500 leading-relaxed">
            New here?{" "}
            <a href="/#early-access" className="text-neutral-300 underline underline-offset-2 hover:text-white">
              Join early access
            </a>.
          </p>
        </motion.div>
      </main>

      <footer className="border-t border-white/10 px-5 py-5 text-center">
        <p className="text-xs text-neutral-600">© {new Date().getFullYear()} CONTYNT</p>
      </footer>
    </div>
  );
}
