import { useState } from "react";
import { Menu, X } from "lucide-react";

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-lg border-b border-white/10">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-5">
        <div className="flex items-center justify-between">
          <a href="/" className="text-2xl tracking-widest text-white hover:opacity-80 transition-opacity" style={{ fontWeight: 600 }}>
            C O N T Y N T
          </a>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8 text-sm text-neutral-300">
            <a href="#how-it-works" className="hover:text-white transition-colors" style={{ fontWeight: 400 }}>
              How It Works
            </a>
            <a href="#features" className="hover:text-white transition-colors" style={{ fontWeight: 400 }}>
              Features
            </a>
            <a href="#faq" className="hover:text-white transition-colors" style={{ fontWeight: 400 }}>
              FAQ
            </a>
            <a href="#businesses" className="hover:text-white transition-colors" style={{ fontWeight: 400 }}>
              For Businesses
            </a>
            <a href="/login" className="px-4 py-2.5 rounded-lg border border-white/20 text-white hover:bg-white/10 transition-all duration-200" style={{ fontWeight: 400 }}>
              Log In
            </a>
            <a href="#early-access" className="px-6 py-2.5 bg-white text-black rounded-lg hover:bg-neutral-100 transition-all duration-200" style={{ fontWeight: 500 }}>
              Join Early Access
            </a>
          </nav>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden text-white p-2"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <nav className="md:hidden mt-6 pb-4 flex flex-col gap-4 text-neutral-300">
            <a
              href="#how-it-works"
              className="hover:text-white transition-colors py-2"
              style={{ fontWeight: 400 }}
              onClick={() => setMobileMenuOpen(false)}
            >
              How It Works
            </a>
            <a
              href="#features"
              className="hover:text-white transition-colors py-2"
              style={{ fontWeight: 400 }}
              onClick={() => setMobileMenuOpen(false)}
            >
              Features
            </a>
            <a
              href="#faq"
              className="hover:text-white transition-colors py-2"
              style={{ fontWeight: 400 }}
              onClick={() => setMobileMenuOpen(false)}
            >
              FAQ
            </a>
            <a
              href="#businesses"
              className="hover:text-white transition-colors py-2"
              style={{ fontWeight: 400 }}
              onClick={() => setMobileMenuOpen(false)}
            >
              For Businesses
            </a>
            <a
              href="/login"
              className="px-6 py-3 rounded-lg border border-white/20 text-white hover:bg-white/10 transition-all duration-200 text-center"
              style={{ fontWeight: 400 }}
              onClick={() => setMobileMenuOpen(false)}
            >
              Log In
            </a>
            <a
              href="#early-access"
              className="px-6 py-3 bg-white text-black rounded-lg hover:bg-neutral-100 transition-all duration-200 text-center"
              style={{ fontWeight: 500 }}
              onClick={() => setMobileMenuOpen(false)}
            >
              Join Early Access
            </a>
          </nav>
        )}
      </div>
    </header>
  );
}