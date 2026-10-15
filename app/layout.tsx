import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev Classifier POC",
  description: "Classificação de produtos com Jev vs classificador atual",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
