import { useState, type CSSProperties } from "react";
import { LB, FONTS } from "../lb";

/**
 * Inline order form rendered under an Order_custom_product tool result:
 * mockups above it, address fields here, POST /api/orders (the same
 * Place_order executor the model uses) on submit.
 */

type Variant = { id: number; title: string };

const fieldStyle: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  border: `1px solid ${LB.border}`,
  background: LB.surface,
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
  minWidth: 0,
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontFamily: FONTS.mono,
  fontSize: 9.5,
  color: LB.textDim,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 3,
  display: "block",
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  span = 1,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  span?: number;
}) {
  return (
    <div style={{ gridColumn: `span ${span}` }}>
      <label style={labelStyle}>{label}</label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        style={fieldStyle}
      />
    </div>
  );
}

export function OrderForm({
  productId,
  variants,
  defaultVariantId,
}: {
  productId: string;
  variants: Variant[];
  defaultVariantId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [variantId, setVariantId] = useState<number | null>(defaultVariantId ?? variants[0]?.id ?? null);
  const [quantity, setQuantity] = useState("1");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [zip, setZip] = useState("");
  const [country, setCountry] = useState("US");

  const ordered = result?.ok === true;
  const canSubmit = !submitting && !ordered
    && firstName.trim() && lastName.trim() && email.trim() && address1.trim()
    && city.trim() && zip.trim() && country.trim().length === 2;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          ...(variantId ? { variant_id: variantId } : {}),
          quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
          address: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            email: email.trim(),
            country: country.trim().toUpperCase(),
            ...(region.trim() ? { region: region.trim() } : {}),
            address1: address1.trim(),
            ...(address2.trim() ? { address2: address2.trim() } : {}),
            city: city.trim(),
            zip: zip.trim(),
          },
        }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok && typeof payload.order_id === "string") {
        setResult({ ok: true, message: `Order ${payload.order_id} created — it'll be mailed to ${firstName.trim()}.` });
      } else {
        setResult({ ok: false, message: typeof payload.error === "string" ? payload.error : `Order failed (HTTP ${response.status}).` });
      }
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "Order failed." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      margin: "6px 0 10px",
      border: `1px solid ${ordered ? LB.green : LB.border}`,
      borderRadius: 10,
      background: ordered ? LB.greenSoft : LB.surface,
      overflow: "hidden",
    }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "9px 12px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
          }}
        >
          <span style={{
            height: 26,
            padding: "0 12px",
            display: "inline-flex",
            alignItems: "center",
            borderRadius: 8,
            background: LB.blue,
            color: "#FFF",
            fontSize: 12,
            fontWeight: 700,
          }}>
            Order this →
          </span>
          <span style={{ fontSize: 12, color: LB.textDim }}>
            Ships via Printify — enter a mailing address
          </span>
        </button>
      ) : (
        <div style={{ padding: "10px 12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {variants.length > 1 && (
              <div style={{ gridColumn: "span 2" }}>
                <label style={labelStyle}>Variant</label>
                <select
                  value={variantId ?? undefined}
                  onChange={(event) => setVariantId(Number.parseInt(event.target.value, 10))}
                  style={{ ...fieldStyle, appearance: "auto" }}
                >
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>{variant.title}</option>
                  ))}
                </select>
              </div>
            )}
            <Field label="Qty" value={quantity} onChange={setQuantity} />
            <div style={{ gridColumn: variants.length > 1 ? "span 1" : "span 3" }} />
            <Field label="First name" value={firstName} onChange={setFirstName} span={2} />
            <Field label="Last name" value={lastName} onChange={setLastName} span={2} />
            <Field label="Email" value={email} onChange={setEmail} placeholder="for order updates" span={4} />
            <Field label="Address" value={address1} onChange={setAddress1} span={4} />
            <Field label="Apt / suite (optional)" value={address2} onChange={setAddress2} span={4} />
            <Field label="City" value={city} onChange={setCity} span={2} />
            <Field label="State / region" value={region} onChange={setRegion} />
            <Field label="ZIP" value={zip} onChange={setZip} />
            <Field label="Country (2-letter)" value={country} onChange={setCountry} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: 8,
                border: "none",
                background: canSubmit ? LB.blue : LB.slateSoft,
                color: canSubmit ? "#FFF" : LB.textDim,
                fontSize: 12.5,
                fontWeight: 700,
                cursor: canSubmit ? "pointer" : "default",
              }}
            >
              {submitting ? "Placing order…" : ordered ? "Ordered ✓" : "Place order"}
            </button>
            {!ordered && (
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: `1px solid ${LB.border}`,
                  background: "transparent",
                  color: LB.textMid,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            )}
            {result && (
              <span style={{ fontSize: 12, color: result.ok ? LB.green : LB.red, fontWeight: 600 }}>
                {result.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
