import { describe, expect, it } from "vitest";
import { googleHdSetting, satisfiesGoogleHd } from "../src/auth/google-hd";

describe("googleHdSetting", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["false", "off"],
    ["true", "on"],
    ["TRUE", "invalid"],
    ["True", "invalid"],
    ["1", "invalid"],
    [" true", "invalid"],
    ["true ", "invalid"],
    ["yes", "invalid"],
    [true, "invalid"],
    [false, "invalid"],
    [null, "invalid"],
  ])("%j is %s", (value, expected) => {
    expect(googleHdSetting(value)).toBe(expected);
  });
});

describe("satisfiesGoogleHd", () => {
  it.each([
    ["someone@gmail.com", {}, true],
    ["someone@gmail.com", { hd: "" }, true],
    ["staff@partner.example", { hd: "partner.example" }, true],
    ["staff@partner.example", { hd: "other.example" }, true],
    ["staff@partner.example", {}, false],
    ["staff@partner.example", { hd: "" }, false],
    ["staff@partner.example", { hd: "  " }, false],
    ["staff@partner.example", { hd: 123 }, false],
    ["staff@partner.example", { hd: null }, false],
    ["someone@googlemail.com", {}, false],
    ["someone@notgmail.com", {}, false],
  ])("%s with %j is %s", (email, claims, expected) => {
    expect(satisfiesGoogleHd(email, claims)).toBe(expected);
  });
});
