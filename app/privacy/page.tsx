import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Privacy Policy — Renderball",
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="June 2026">
      <Clause heading="1. Overview">
        <p>
          This Privacy Policy explains what Renderball, Inc. (&ldquo;we&rdquo;)
          collects, why, and your choices. It applies to renderball.com and the
          Renderball service.
        </p>
      </Clause>
      <Clause heading="2. What we collect">
        <p>
          <strong>Account data:</strong> your name and email, provided through
          our authentication provider when you sign up or sign in.
        </p>
        <p>
          <strong>Content you provide:</strong> briefs, prompts, uploaded brand
          assets (logos, images), and the website URLs you ask us to analyze.
        </p>
        <p>
          <strong>Usage data:</strong> the documents you generate, build and
          export history, and basic technical logs needed to operate and secure
          the Service.
        </p>
        <p>
          <strong>Payment data:</strong> processed by our third-party payment
          processor. We do not store your full card details.
        </p>
      </Clause>
      <Clause heading="3. How we use it">
        <p>
          To provide and improve the Service: authenticating you, generating
          and building your documents, hosting your files, processing payments,
          preventing abuse, and providing support. We do not sell your personal
          information.
        </p>
      </Clause>
      <Clause heading="4. Subprocessors">
        <p>
          We share data with vendors that help us run the Service, only as needed
          to provide it. These currently include: authentication (Clerk), AI
          model inference (Fireworks AI, which serves the language and vision
          models that write and check your document), file and database storage
          (Cloudflare R2, Neon), application hosting (Railway), stock imagery
          lookup (Pexels), and payments (our payment processor, which is the
          merchant of record for your purchase). Each processes data under its
          own terms.
        </p>
      </Clause>
      <Clause heading="5. Retention and deletion">
        <p>
          We keep your data while your account is active and as needed to provide
          the Service. You can request access to, correction of, or deletion of
          your personal data by emailing us; we will delete your account data and
          generated files except where we must retain records to comply with law.
        </p>
      </Clause>
      <Clause heading="6. Security">
        <p>
          We use industry-standard measures to protect your data, including
          access controls and encrypted connections. No system is perfectly
          secure, but we work to safeguard your information.
        </p>
      </Clause>
      <Clause heading="7. Children">
        <p>
          The Service is not directed to children under 18, and we do not
          knowingly collect their data.
        </p>
      </Clause>
      <Clause heading="8. Changes">
        <p>
          We may update this policy; material changes will be posted here with a
          new effective date.
        </p>
      </Clause>
      <Clause heading="9. Contact">
        <p>
          Privacy questions or data requests:{" "}
          <a className="text-accent-text underline" href="mailto:support@renderball.com">
            support@renderball.com
          </a>
          .
        </p>
      </Clause>
    </LegalShell>
  );
}
