import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-black to-neutral-900 text-white">
      {/* Subtle background pattern */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 1px)`,
          backgroundSize: '40px 40px'
        }} />
      </div>
      
      {/* Gradient overlays */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-blue-500/20 blur-[150px] rounded-full" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-purple-500/10 blur-[120px] rounded-full" />
      
      <div className="relative max-w-7xl mx-auto px-6 lg:px-8 pt-28 md:pt-32 pb-24 md:pb-40">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="max-w-4xl mx-auto text-center"
        >
          {/* Headline */}
          <h1 className="text-4xl md:text-6xl lg:text-7xl tracking-tight mb-6" style={{ fontWeight: 600, lineHeight: 1.1 }}>
            Earn by Creating <br className="md:hidden" />
            Content in Your City
          </h1>

          {/* Subheadline */}
          <p className="text-lg md:text-xl text-neutral-300 mb-12 max-w-2xl mx-auto" style={{ fontWeight: 400, lineHeight: 1.6 }}>
            Contynt connects creators with local spots that want to be featured through short-form content.
          </p>
          
          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a href="#early-access" className="group px-8 py-4 bg-white text-black rounded-lg hover:bg-neutral-100 transition-all duration-200 flex items-center gap-2" style={{ fontWeight: 500 }}>
              Join Creator Access
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </a>
            <a href="#how-it-works" className="px-8 py-4 bg-white/10 text-white rounded-lg hover:bg-white/20 backdrop-blur-sm transition-all duration-200 border border-white/20" style={{ fontWeight: 500 }}>
              How It Works
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}