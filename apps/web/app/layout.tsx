import "./globals.css";

export const metadata = { title: "kb-studio · 知识库处理台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
