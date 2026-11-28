Amazon's own published VIDR samples, byte-for-byte (public, placeholder data), from the VAT Calculation Service developer guide:
- VIDR_FLAT_FILE_SAMPLE.csv  https://m.media-amazon.com/images/G/01/B2B/DeveloperGuide/VIDR_FLAT_FILE_SAMPLE_uienckehfi429fj2iu8gfjldf.csv  sha256 ef3e891d4f234b8ba286151c28ed7d0ea83d1b761b60afa12dc5f20d6d606c54
- VIDR_XML_SAMPLE_V2.xml     https://m.media-amazon.com/images/G/01/B2B/DeveloperGuide/xkerijcje134fkekrld_VIDR_XML_SAMPLE_V2_3ifmdktvjdkfjhaf.xml  sha256 94ff989aec8ca52f2a774ebb15c63649cee05fc5bb851bfa9e5d04e1ea359403
Quirks kept on purpose: the CSV is comma-separated (documented format is tab), is not valid UTF-8 (bytes 0x81 0x82 0x84 0x85 = CP437/850 u-umlaut, e-acute, a-umlaut, a-grave), has CRLF endings, 86 columns, no correction columns. The XML has a UTF-8 BOM, tabs/newlines inside values, mixed EUR/GBP amounts inside one item (message 5), and every IsBusinessOrder false.
Do not edit these files.
