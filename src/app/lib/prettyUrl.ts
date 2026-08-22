// How a CONTYNT link is shown to a person, as opposed to how it is stored.
//
// Hosts are case-insensitive, so capitalising the words costs nothing and makes
// the link easier to read off a printed card and type by hand. Display only:
// QR codes, hrefs and anything copied to the clipboard keep the real lowercase
// URL, so nothing depends on the casing.
//
// Shared so the printable and the Ambassador tab cannot drift apart.
export const prettyUrl = (u: string): string =>
  (u || "")
    .replace(/^https?:\/\//, "")
    .replace(/^getcontynt\.com/i, "GetContynt.com");
