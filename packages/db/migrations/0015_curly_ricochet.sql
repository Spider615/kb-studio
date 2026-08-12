-- 验证码表按用途拆分：同一邮箱的「注册码」与「重置密码码」并存，互不覆盖。
-- 手工修正 drizzle 生成结果：补上 DROP 旧主键，并把加列提到建复合主键之前
-- （原生成顺序会在 purpose 列还不存在时就引用它）。
ALTER TABLE "email_verifications" ADD COLUMN "purpose" text DEFAULT 'register' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_pkey";--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_email_purpose_pk" PRIMARY KEY("email","purpose");
