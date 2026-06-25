// Shared MBOX serializer. Both the Gmail API importer and the IMAP poller stream
// fetched messages into an MBOX file the same way: a "From " separator line, then the
// RFC822 body with CRLFs normalized and any body line starting with "From " escaped.
export function writeMboxMessage(out: NodeJS.WritableStream, rawRfc822: string, fromPrefix: string): void {
  out.write(`From ${fromPrefix} ${new Date().toUTCString()}\n`);
  out.write(rawRfc822.replace(/\r\n/g, "\n").replace(/\n(From )/g, "\n>$1"));
  out.write("\n\n");
}
