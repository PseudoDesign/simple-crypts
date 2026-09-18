// Independent interoperability oracle: deliberately does not import the C SDK.
package main

import (
    "encoding/hex"
    "fmt"
    "os"
    "golang.org/x/crypto/nacl/box"
)

func decode(s string, length int) []byte {
    b, err := hex.DecodeString(s)
    if err != nil || (length >= 0 && len(b) != length) { panic("invalid fixture") }
    return b
}

func main() {
    if len(os.Args) != 6 { panic("seal|open secret peer nonce data (hex)") }
    var secret, peer [32]byte
    var nonce [24]byte
    copy(secret[:], decode(os.Args[2], 32))
    copy(peer[:], decode(os.Args[3], 32))
    copy(nonce[:], decode(os.Args[4], 24))
    data := decode(os.Args[5], -1)
    var result []byte
    switch os.Args[1] {
    case "seal": result = box.Seal(nil, data, &nonce, &peer, &secret)
    case "open":
        var ok bool
        result, ok = box.Open(nil, data, &nonce, &peer, &secret)
        if !ok { fmt.Fprintln(os.Stderr, "authentication failed"); os.Exit(2) }
    default: panic("invalid operation")
    }
    fmt.Println(hex.EncodeToString(result))
}
