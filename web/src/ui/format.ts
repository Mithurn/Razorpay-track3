export function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

export function customerLabel(ref: string): string {
  return ref.startsWith("cust_") ? `customer_${ref.slice("cust_".length)}` : ref;
}
