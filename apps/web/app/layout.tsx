import "./globals.css";
import { Toaster } from "../components/Toast";

export const metadata = { title: "kb-studio · 知识库处理台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
