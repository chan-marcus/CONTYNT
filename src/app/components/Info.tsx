import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { projectId, publicAnonKey } from "/utils/supabase/info";

export function Info() {
  const [instagram, setInstagram] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [preferredContact, setPreferredContact] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Disable scrolling when component mounts
    document.body.style.overflow = "hidden";

    // Re-enable scrolling when component unmounts
    return () => {
      document.body.style.overflow = "unset";
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSuccessMessage("");

    try {
      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c/business-signup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${publicAnonKey}`,
          },
          body: JSON.stringify({
            instagram,
            email,
            city,
            address,
            preferredContact,
          }),
        }
      );

      const data = await response.json();

      if (response.ok) {
        setSuccessMessage(data.message || "Thank you! We'll be in touch.");
        setInstagram("");
        setEmail("");
        setCity("");
        setAddress("");
        setPreferredContact("");
      } else {
        setSuccessMessage(data.error || "Something went wrong. Please try again.");
      }
    } catch (error) {
      console.error("Business signup error:", error);
      setSuccessMessage("Network error. Please check your connection and try again.");
    } finally {
      setIsSubmitting(false);
      setTimeout(() => {
        setSuccessMessage("");
      }, 3000);
    }
  };

  const handleClose = () => {
    window.location.hash = "";
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 bg-white/40 backdrop-blur-md z-[9999] flex items-center justify-center px-6"
        onClick={handleClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.25 }}
          className="max-w-lg w-full"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-white rounded-2xl shadow-2xl border border-neutral-200 p-8">
            <h2 className="text-3xl font-bold text-neutral-900 mb-3 text-center">
              Get content from<br />local creators
            </h2>
            <p className="text-neutral-600 text-center mb-6">
              We connect your business with creators who produce real, high-quality content in your city.
            </p>
            <p className="text-sm font-medium text-neutral-900 mb-6 text-center">
              We're onboarding a small group of businesses
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="text"
                value={instagram}
                onChange={(e) => setInstagram(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white"
                placeholder="Instagram Handle"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white"
                placeholder="Business Address"
                required
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white"
                placeholder="Email"
                required
              />
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white"
                required
              >
                <option value="">Select City</option>
                <option value="San Francisco">San Francisco</option>
                <option value="Los Angeles">Los Angeles</option>
                <option value="New York City">New York City</option>
              </select>
              <select
                value={preferredContact}
                onChange={(e) => setPreferredContact(e.target.value)}
                className="w-full px-4 py-3 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent bg-white"
                required
              >
                <option value="">Preferred way to reach you</option>
                <option value="Instagram">Instagram</option>
                <option value="Email">Email</option>
              </select>
              {successMessage && (
                <p className="text-green-600 text-sm">{successMessage}</p>
              )}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full px-4 py-3 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Submitting..." : "I'm Interested!"}
              </button>
            </form>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
