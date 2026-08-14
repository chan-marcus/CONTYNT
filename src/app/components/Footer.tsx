export function Footer() {
  return (
    <footer className="bg-black text-white py-12 border-t border-neutral-800">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="text-2xl tracking-widest" style={{ fontWeight: 600 }}>
            C O N T Y N T
          </div>
          
          <div className="flex gap-8 text-sm text-neutral-400">
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
          </div>
        </div>

        <div className="flex flex-col md:flex-row justify-between items-center mt-8 pt-8 border-t border-neutral-800">
          <p className="text-sm text-neutral-500" style={{ fontWeight: 400 }}>
            © 2026 Contynt. All rights reserved.
          </p>
          <a href="#analytics" className="text-sm text-neutral-400 hover:text-white transition-colors mt-4 md:mt-0" style={{ fontWeight: 400 }}>
            Analytics
          </a>
        </div>
      </div>
    </footer>
  );
}