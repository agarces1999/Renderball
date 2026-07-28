import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Acceptable Use & AI Content Policy — Renderball",
  description:
    "What Renderball's AI does and does not generate, how customer data reaches our model providers, and the rules for using the Service.",
};

/**
 * Acceptable Use & AI Content Policy.
 *
 * Written for two audiences at once: customers, and the payment provider that
 * has to underwrite us. Merchant-of-record platforms flag AI products for
 * manual review and then ask the same three questions — what does it generate,
 * what stops it generating something harmful, and where does customer data go.
 * Answering them on a public page turns a documentation request into a link.
 *
 * The substantive point for underwriting is that Renderball is a B2B design
 * TOOL whose output is business documents, not a general image or likeness
 * generator: it cannot produce photorealistic people, voices, or likenesses,
 * which is the category payment platforms actually restrict.
 */
export default function AcceptableUsePage() {
  return (
    <LegalShell title="Acceptable Use & AI Content Policy" updated="July 2026">
      <Clause heading="1. What Renderball is">
        <p>
          Renderball is a business-to-business design tool. Customers use it to
          make presentation decks and similar business documents: slides made of
          text, charts, diagrams, tables, shapes and layout. Output is editable
          document content — every element remains a real object the customer can
          move, rewrite or delete — not a flattened picture.
        </p>
      </Clause>

      <Clause heading="2. What our AI does">
        <p>
          Renderball uses third-party language models to do three things: draft an
          outline from the customer&rsquo;s own brief, write the layout and copy for
          each page as editable document code, and regenerate a single element on
          request. A vision model checks rendered pages for legibility problems
          such as low contrast or overlapping text.
        </p>
        <p>
          Optionally, and only when the customer supplies their own website
          address, we read that page to extract their brand&rsquo;s colours, fonts
          and logo so the document matches their brand.
        </p>
      </Clause>

      <Clause heading="3. What our AI does not do">
        <p>
          Renderball does not generate photorealistic images of people, human
          likenesses, faces, voices, or video of any person. It has no
          face-swap, voice-cloning, avatar, or &ldquo;deepfake&rdquo; capability
          and no feature that edits a photograph of a person. It does not
          generate adult content. Where a document needs a photograph, Renderball
          uses licensed stock imagery from Pexels or an image the customer
          uploads themselves.
        </p>
      </Clause>

      <Clause heading="4. Where customer data goes">
        <p>
          Text a customer provides — their brief, their document copy, their brand
          guidelines — is sent to our model provider, Fireworks AI, to produce the
          document, and to no other model provider. Rendered page images are sent
          to the same provider for the legibility check. We do not sell customer
          data, and we do not use customer content to train models. Our full
          vendor list is in the{" "}
          <a className="text-accent-text underline" href="/privacy">
            Privacy Policy
          </a>
          .
        </p>
      </Clause>

      <Clause heading="5. Safeguards">
        <p>
          Generated documents are checked before a customer sees them: automated
          gates verify that every factual claim in the output traces back to
          something the customer wrote or to text read from their own website, so
          the model cannot invent statistics about their business. Generated
          document code is executed in an isolated process that holds no
          credentials and is stopped automatically if it does not finish. Uploaded
          files are type-checked by content rather than filename, and uploaded
          vector images are stripped of any embedded script.
        </p>
      </Clause>

      <Clause heading="6. What you may not use Renderball for">
        <p>You may not use the Service to create or distribute:</p>
        <p>
          Content that infringes anyone&rsquo;s intellectual property, including
          brand assets you are not authorised to use. Content that impersonates a
          real person, company or public authority. Fraudulent or deceptive
          material, including fake invoices, receipts, credentials, or financial
          documents presented as genuine. Content that harasses, defames or
          discriminates. Content that is unlawful in the jurisdictions where you
          or your audience are located. Malware, or any attempt to make the
          Service execute code outside the documents it produces.
        </p>
        <p>
          You are responsible for the documents you make and for having the rights
          to any brand assets, imagery, fonts or copy you supply.
        </p>
      </Clause>

      <Clause heading="7. Reporting and enforcement">
        <p>
          Report misuse to{" "}
          <a className="text-accent-text underline" href="mailto:abuse@renderball.com">
            abuse@renderball.com
          </a>
          . We investigate every report and may suspend or terminate accounts that
          breach this policy. Where we are legally required to act on a report, we
          will.
        </p>
      </Clause>
    </LegalShell>
  );
}
