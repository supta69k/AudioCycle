/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glass: "0 12px 35px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28)",
      },
    },
  },
  plugins: [],
};
