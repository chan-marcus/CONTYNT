import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { projectId, publicAnonKey } from "/utils/supabase/info";

export function FinalCTA() {
  const [instagram, setInstagram] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [customCity, setCustomCity] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitMessage("");

    try {
      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c/signup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${publicAnonKey}`,
          },
          body: JSON.stringify({
            instagram,
            email,
            city: city === "other" ? customCity : city,
          }),
        }
      );

      const data = await response.json();

      if (response.ok) {
        setSubmitMessage("Success! You're on the early access list.");
        // Clear form
        setInstagram("");
        setEmail("");
        setCity("");
      } else {
        setSubmitMessage(data.error || "Something went wrong. Please try again.");
      }
    } catch (error) {
      console.error("Signup error:", error);
      setSubmitMessage("Network error. Please check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section id="early-access" className="relative overflow-hidden bg-gradient-to-br from-neutral-900 via-neutral-800 to-black text-white py-16 md:py-32">
      {/* Subtle gradient overlays */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-500/10 blur-[120px] rounded-full" />
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-purple-500/10 blur-[100px] rounded-full" />
      
      <div className="relative max-w-4xl mx-auto px-6 lg:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl md:text-4xl lg:text-5xl mb-6 text-white text-center" style={{ fontWeight: 600, lineHeight: 1.2 }}>
            Join Early Access
            <br />
            to Contynt
          </h2>
          <p className="text-base md:text-lg text-neutral-300 mb-12 max-w-2xl mx-auto text-center" style={{ fontWeight: 400, lineHeight: 1.6 }}>
            Be among the first creators
            <br />
            to monetize your content with local businesses
          </p>

          <form onSubmit={handleSubmit} className="max-w-md mx-auto space-y-4">
            <div className="text-left">
              <label className="block text-white mb-2 text-sm md:text-base" style={{ fontWeight: 400 }}>
                Instagram
              </label>
              <input
                type="text"
                placeholder="Instagram Handle"
                value={instagram}
                onChange={(e) => setInstagram(e.target.value)}
                required
                className="w-full px-4 md:px-6 py-3 md:py-4 bg-white/10 border border-white/20 rounded-lg text-white text-sm md:text-base placeholder:text-neutral-400 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div className="text-left">
              <label className="block text-white mb-2 text-sm md:text-base" style={{ fontWeight: 400 }}>
                Email <span className="italic text-neutral-400">(for new feature alerts)</span>
              </label>
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 md:px-6 py-3 md:py-4 bg-white/10 border border-white/20 rounded-lg text-white text-sm md:text-base placeholder:text-neutral-400 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div className="text-left">
              <label className="block text-white mb-2 text-sm md:text-base" style={{ fontWeight: 400 }}>
                City
              </label>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full px-4 md:px-6 py-3 md:py-4 bg-white/10 border border-white/20 rounded-lg text-white text-sm md:text-base placeholder:text-neutral-400 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                required
              >
                <option value="" disabled className="bg-neutral-900 text-neutral-400">City</option>
                <option value="san-francisco" className="bg-neutral-900 text-white">San Francisco</option>
                <option value="los-angeles" className="bg-neutral-900 text-white">Los Angeles</option>
                <option value="new-york" className="bg-neutral-900 text-white">New York City</option>
                <option value="other" className="bg-neutral-900 text-white">Other</option>
              </select>
              {city === "other" && (
                <input
                  type="text"
                  placeholder="Enter your city"
                  value={customCity}
                  onChange={(e) => setCustomCity(e.target.value)}
                  required
                  className="w-full px-4 md:px-6 py-3 md:py-4 bg-white/10 border border-white/20 rounded-lg text-white text-sm md:text-base placeholder:text-neutral-400 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              )}
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="group w-full px-8 py-4 bg-white text-black rounded-lg hover:bg-neutral-100 transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ fontWeight: 500 }}
            >
              {isSubmitting ? "Submitting..." : "Get Early Access"}
              {!isSubmitting && <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />}
            </button>
          </form>

          {submitMessage && (
            <p className={`text-sm mt-6 ${submitMessage.includes("Success") ? "text-green-400" : "text-red-400"}`} style={{ fontWeight: 400 }}>
              {submitMessage}
            </p>
          )}

          <p className="text-sm text-neutral-400 mt-8" style={{ fontWeight: 400 }}>
            Creators are assessed on the quality and consistency of their recent content.
          </p>
        </motion.div>
      </div>
    </section>
  );
}