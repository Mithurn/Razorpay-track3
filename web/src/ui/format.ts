export function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

export function customerLabel(ref: string): string {
  return ref.startsWith("cust_") ? `customer_${ref.slice("cust_".length)}` : ref;
}

const BANK_NAMES: Record<string, string> = {
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank",
  SBIN: "State Bank of India",
  PUNB: "Punjab National Bank",
  BKID: "Bank of India",
  CNRB: "Canara Bank",
  UBIN: "Union Bank of India",
  IOBA: "Indian Overseas Bank",
  BARB: "Bank of Baroda",
  IDBI: "IDBI Bank",
  YESB: "Yes Bank",
  INDB: "IndusInd Bank",
  FDRL: "Federal Bank",
  KVBL: "Karur Vysya Bank",
  CITI: "Citibank",
  SCBL: "Standard Chartered",
  HSBC: "HSBC Bank",
  RATN: "RBL Bank",
  AIRP: "Airtel Payments Bank",
  PYTM: "Paytm Payments Bank",
};

export function bankName(code: string): string {
  return BANK_NAMES[code.toUpperCase()] ?? code;
}
