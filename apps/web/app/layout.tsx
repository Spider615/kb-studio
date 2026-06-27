import "./globals.css";
import Nav from "../components/Nav";

export const metadata = { title: "kb-studio · 知识库处理台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <div className="app">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
