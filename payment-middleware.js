// Adapted from x402-express 1.2.0, x402 Foundation, Apache-2.0.
// Local changes: durable settlement hooks before payment and before response flush.
// src/index.ts
import { getAddress } from "viem";
import { readPayment, v2Requirement, matchesV2, receiptHeaders } from './payment-protocol.js';
import { exact } from "x402/schemes";
import {
  computeRoutePatterns,
  findMatchingPaymentRequirements,
  findMatchingRoute,
  processPriceToAtomicAmount,
  toJsonSafe
} from "x402/shared";
// This service uses agent payments, never the SDK's bundled browser wallet UI.
function getPaywallHtml() { return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Payment required — The Latent Lounge</title><link rel="stylesheet" href="/lounge.css"><main class="wrap page-hero"><h1>Bring your agent.</h1><p>This is a paid API endpoint. Your agent can inspect its x402 payment requirements using Accept: application/json.</p><a class="button primary" href="/connect.html">Connection and payment guide</a><p><a href="/#try">Try a free puzzle first</a></p></main></html>'; }
import {
  moneySchema,
  settleResponseHeader,
  SupportedEVMNetworks,
  SupportedSVMNetworks
} from "x402/types";
import { useFacilitator } from "x402/verify";
function paymentMiddleware(payTo, routes, facilitator, paywall, hooks = {}) {
  const service = useFacilitator(facilitator);
  async function bounded(fn,args) {
    let timer;
    try { return await Promise.race([fn(...args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Facilitator timeout')),20000);})]); }
    finally { clearTimeout(timer); }
  }
  const verify=(...args)=>bounded(service.verify,args), settle=(...args)=>bounded(service.settle,args), supported=(...args)=>bounded(service.supported,args);
  const routePatterns = computeRoutePatterns(routes);
  return async function paymentMiddleware2(req, res, next) {
    var _a;
    const matchingRoute = findMatchingRoute(routePatterns, req.path, req.method.toUpperCase());
    if (!matchingRoute) {
      return next();
    }
    const { price, network, config = {} } = matchingRoute.config;
    const {
      description,
      mimeType,
      maxTimeoutSeconds,
      inputSchema,
      outputSchema,
      customPaywallHtml,
      resource,
      discoverable
    } = config;
    const atomicAmountForAsset = processPriceToAtomicAmount(price, network);
    if ("error" in atomicAmountForAsset) {
      throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;
    const resourceUrl = resource || `${req.protocol}://${req.headers.host}${req.path}`;
    let paymentRequirements = [];
    if (SupportedEVMNetworks.includes(network)) {
      paymentRequirements.push({
        scheme: "exact",
        network,
        maxAmountRequired,
        resource: resourceUrl,
        description: description ?? "",
        mimeType: mimeType ?? "",
        payTo: getAddress(payTo),
        maxTimeoutSeconds: maxTimeoutSeconds ?? 60,
        asset: getAddress(asset.address),
        // TODO: Rename outputSchema to requestStructure
        outputSchema: {
          input: {
            type: "http",
            method: req.method.toUpperCase(),
            discoverable: discoverable ?? true,
            ...inputSchema
          },
          output: outputSchema
        },
        extra: asset.eip712
      });
    } else if (SupportedSVMNetworks.includes(network)) {
      const paymentKinds = await supported();
      let feePayer;
      for (const kind of paymentKinds.kinds) {
        if (kind.network === network && kind.scheme === "exact") {
          feePayer = (_a = kind == null ? void 0 : kind.extra) == null ? void 0 : _a.feePayer;
          break;
        }
      }
      if (!feePayer) {
        throw new Error(`The facilitator did not provide a fee payer for network: ${network}.`);
      }
      paymentRequirements.push({
        scheme: "exact",
        network,
        maxAmountRequired,
        resource: resourceUrl,
        description: description ?? "",
        mimeType: mimeType ?? "",
        payTo,
        maxTimeoutSeconds: maxTimeoutSeconds ?? 60,
        asset: asset.address,
        // TODO: Rename outputSchema to requestStructure
        outputSchema: {
          input: {
            type: "http",
            method: req.method.toUpperCase(),
            discoverable: discoverable ?? true,
            ...inputSchema
          },
          output: outputSchema
        },
        extra: {
          feePayer
        }
      });
    } else {
      throw new Error(`Unsupported network: ${network}`);
    }
    const x402Version = req.header('PAYMENT-SIGNATURE') ? 2 : 1;
    const v2Requirements = paymentRequirements.map(v2Requirement);
    // v2's canonical challenge is the header; preserve the v1 body for old clients.
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify({x402Version:2,resource:{url:resourceUrl,description:description || '',mimeType:'application/json'},accepts:v2Requirements})).toString('base64'));
    res.setHeader('Access-Control-Expose-Headers','PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');
    const payment = req.header('PAYMENT-SIGNATURE') || req.header("X-PAYMENT");
    const userAgent = req.header("User-Agent") || "";
    const acceptHeader = req.header("Accept") || "";
    const isWebBrowser = acceptHeader.includes("text/html") && userAgent.includes("Mozilla");
    if (!payment) {
      if (isWebBrowser) {
        let displayAmount;
        if (typeof price === "string" || typeof price === "number") {
          const parsed = moneySchema.safeParse(price);
          if (parsed.success) {
            displayAmount = parsed.data;
          } else {
            displayAmount = Number.NaN;
          }
        } else {
          displayAmount = Number(price.amount) / 10 ** price.asset.decimals;
        }
        const html = customPaywallHtml || getPaywallHtml({
          amount: displayAmount,
          paymentRequirements: toJsonSafe(paymentRequirements),
          currentUrl: req.originalUrl,
          testnet: network === "base-sepolia",
          cdpClientKey: paywall == null ? void 0 : paywall.cdpClientKey,
          appName: paywall == null ? void 0 : paywall.appName,
          appLogo: paywall == null ? void 0 : paywall.appLogo,
          sessionTokenEndpoint: paywall == null ? void 0 : paywall.sessionTokenEndpoint
        });
        res.status(402).send(html);
        return;
      }
      res.status(402).json({
        x402Version,
        error: "X-PAYMENT header is required",
        accepts: toJsonSafe(paymentRequirements)
      });
      return;
    }
    let decodedPayment;
    try {
      decodedPayment = readPayment(req);
      if (x402Version===1) decodedPayment = exact.evm.decodePayment(payment);
    } catch (error) {
      res.status(402).json({
        x402Version,
        error: "Invalid or malformed payment header",
        accepts: toJsonSafe(paymentRequirements)
      });
      return;
    }
    const selectedPaymentRequirements = x402Version===2 ? v2Requirements.find(r=>matchesV2(decodedPayment,r)) : findMatchingPaymentRequirements(
      paymentRequirements,
      decodedPayment
    );
    if (!selectedPaymentRequirements) {
      res.status(402).json({
        x402Version,
        error: "Unable to find matching payment requirements",
        accepts: toJsonSafe(paymentRequirements)
      });
      return;
    }
    try {
      const response = await verify(decodedPayment, selectedPaymentRequirements);
      if (response.isValid !== true) {
        res.status(402).json({
          x402Version,
          error: response.invalidReason,
          accepts: toJsonSafe(paymentRequirements),
          payer: response.payer
        });
        return;
      }
    } catch (error) {
      res.status(402).json({
        x402Version,
        error: "Payment verification failed",
        accepts: toJsonSafe(paymentRequirements)
      });
      return;
    }
    const originalWriteHead = res.writeHead.bind(res);
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalFlushHeaders = res.flushHeaders.bind(res);
    let bufferedCalls = [];
    let settled = false;
    let endCalled;
    const endPromise = new Promise((resolve) => {
      endCalled = resolve;
    });
    res.writeHead = function(...args) {
      if (!settled) {
        bufferedCalls.push(["writeHead", args]);
        return res;
      }
      return originalWriteHead(...args);
    };
    res.write = function(...args) {
      if (!settled) {
        bufferedCalls.push(["write", args]);
        return true;
      }
      return originalWrite(...args);
    };
    res.end = function(...args) {
      if (!settled) {
        bufferedCalls.push(["end", args]);
        endCalled();
        return res;
      }
      return originalEnd(...args);
    };
    res.flushHeaders = function() {
      if (!settled) {
        bufferedCalls.push(["flushHeaders", []]);
        return;
      }
      return originalFlushHeaders();
    };
    next();
    await endPromise;
    if (res.statusCode >= 400) {
      settled = true;
      res.writeHead = originalWriteHead;
      res.write = originalWrite;
      res.end = originalEnd;
      res.flushHeaders = originalFlushHeaders;
      for (const [method, args] of bufferedCalls) {
        if (method === "writeHead")
          originalWriteHead(...args);
        else if (method === "write") originalWrite(...args);
        else if (method === "end") originalEnd(...args);
        else if (method === "flushHeaders") originalFlushHeaders();
      }
      bufferedCalls = [];
      return;
    }
    try {
      hooks.prepare?.(req,res,decodedPayment,selectedPaymentRequirements,bufferedCalls);
    } catch (error) {
      bufferedCalls = [];
      res.status(503).json({error:'Storage unavailable before settlement. No new payment was submitted.'});
      settled = true;
      res.writeHead = originalWriteHead; res.write = originalWrite; res.end = originalEnd; res.flushHeaders = originalFlushHeaders;
      for (const [method,args] of bufferedCalls) { if(method === 'end') originalEnd(...args); }
      return;
    }
    let confirmed = false;
    try {
      const settleResponse = await settle(decodedPayment, selectedPaymentRequirements);
      const responseHeader = settleResponseHeader(settleResponse);
      if (typeof settleResponse.success !== 'boolean') throw new Error('Invalid settlement response');
      if (!settleResponse.success) {
        if (settleResponse.transaction || settleResponse.errorReason==='settlement_pending') throw new Error('Settlement is uncertain');
        hooks.rejected?.(req,res);
        bufferedCalls = [];
        res.status(402).json({
          x402Version,
          error: settleResponse.errorReason,
          accepts: toJsonSafe(paymentRequirements)
        });
        return;
      }
      confirmed = true;
      hooks.confirmed?.(req,res,responseHeader);
      res.removeHeader('PAYMENT-REQUIRED');
      receiptHeaders(res,responseHeader);
    } catch (error) {
      console.error("Settlement requires reconciliation; review the private recovery record.");
      hooks.uncertain?.(req,res,confirmed);
      bufferedCalls = [];
      res.status(503).json({
        x402Version,
        error: "Payment settlement requires recovery. Do not repurchase.",
        accepts: toJsonSafe(paymentRequirements)
      });
      return;
    } finally {
      settled = true;
      res.writeHead = originalWriteHead;
      res.write = originalWrite;
      res.end = originalEnd;
      res.flushHeaders = originalFlushHeaders;
      for (const [method, args] of bufferedCalls) {
        if (method === "writeHead")
          originalWriteHead(...args);
        else if (method === "write") originalWrite(...args);
        else if (method === "end") originalEnd(...args);
        else if (method === "flushHeaders") originalFlushHeaders();
      }
      bufferedCalls = [];
    }
  };
}
export {
  paymentMiddleware
};
