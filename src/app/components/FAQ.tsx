import { motion } from "motion/react";

const faqs = [
  {
    question: "Is there a follower requirement?",
    answer: "No. We evaluate your current content quality and consistency.",
  },
  {
    question: "How does payment work?",
    answer: "You're paid per approved feature posted.",
  },
  {
    question: "Which platforms does Contynt support?",
    answer: "Instagram Reels.",
  },
  {
    question: "Is Contynt available in my city?",
    answer: "We're launching city by city. Join early access to get notified.",
  },
];

export function FAQ() {
  return (
    <section id="faq" className="bg-neutral-50 py-16 md:py-32">
      <div className="max-w-3xl mx-auto px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12 md:mb-20"
        >
          <h2 className="text-3xl md:text-5xl mb-4 text-neutral-900" style={{ fontWeight: 600, lineHeight: 1.2 }}>
            FAQ
          </h2>
          <p className="text-base md:text-lg text-neutral-500 max-w-2xl mx-auto" style={{ fontWeight: 400 }}>
            Quick answers to common questions
          </p>
        </motion.div>

        <div className="space-y-8 md:space-y-12">
          {faqs.map((faq, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              className="pb-8 md:pb-12 border-b border-neutral-200 last:border-b-0 last:pb-0"
            >
              <h3 className="text-lg md:text-xl mb-3 text-neutral-900" style={{ fontWeight: 600 }}>
                {faq.question}
              </h3>
              <p className="text-base md:text-lg text-neutral-600" style={{ fontWeight: 400 }}>
                {faq.answer}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
