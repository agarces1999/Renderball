import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Contact — Renderball",
  description: "How to reach Renderball for support, billing, privacy requests and abuse reports.",
};

/**
 * A reachable contact surface.
 *
 * Support addresses existed only inside the body of the refund and privacy
 * pages, so /contact was a 404. Payment providers underwriting a business
 * check that a real customer can reach a real company before they approve it,
 * and buyers look for the same thing before paying a company they have not
 * heard of.
 */
export default function ContactPage() {
  return (
    <LegalShell title="Contact" updated="July 2026">
      <Clause heading="Support">
        <p>
          Questions about using Renderball, or something not working?{" "}
          <a className="text-accent-text underline" href="mailto:support@renderball.com">
            support@renderball.com
          </a>
          . We answer every email, usually within one business day.
        </p>
      </Clause>

      <Clause heading="Billing and refunds">
        <p>
          For a charge you want reviewed, email{" "}
          <a className="text-accent-text underline" href="mailto:support@renderball.com">
            support@renderball.com
          </a>{" "}
          with your account email and the charge in question. What we refund and
          when is set out in the{" "}
          <a className="text-accent-text underline" href="/refunds">
            Refund Policy
          </a>
          . Payments are handled by our payment processor, which is the merchant
          of record for your purchase and issues your invoice.
        </p>
      </Clause>

      <Clause heading="Privacy and data requests">
        <p>
          To access, correct, export or delete your personal data, email{" "}
          <a className="text-accent-text underline" href="mailto:privacy@renderball.com">
            privacy@renderball.com
          </a>
          . See the{" "}
          <a className="text-accent-text underline" href="/privacy">
            Privacy Policy
          </a>{" "}
          for what we hold and who processes it.
        </p>
      </Clause>

      <Clause heading="Abuse and copyright">
        <p>
          To report misuse of the Service, or content that infringes your rights,
          email{" "}
          <a className="text-accent-text underline" href="mailto:abuse@renderball.com">
            abuse@renderball.com
          </a>
          . Our rules for what may and may not be made with Renderball are in the{" "}
          <a className="text-accent-text underline" href="/acceptable-use">
            Acceptable Use &amp; AI Content Policy
          </a>
          .
        </p>
      </Clause>
    </LegalShell>
  );
}
