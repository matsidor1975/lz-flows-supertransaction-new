import { 
    parseUnits, 
    pad, 
    concat, 
    numberToHex, 
    encodeAbiParameters, 
    parseAbiParameters, 
    type Address, 
    createWalletClient, 
    http, 
    formatUnits 
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { encodeBuildOperation, encodeSwapOperation } from './encoderUtils';

// ============================================
// Constants
// ============================================
const apiKey = "mee_HyAhKoEgRJLxW6QrMasGW";
const meeApiUrl = 'https://api.biconomy.io/v1/instructions/compose';

// LayerZero endpoint IDs
const eidBase = 30184;
const eidEthereum = 30101;

// Known vault tokens and composers
const knownVaults = {
    usr: {
        asset: "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9" as Address,  // USR OFT on Base
        share: "0xb67675158b412d53fe6b68946483ba920b135ba1" as Address,  // wstUSR OFT on Base
        composer: "0x4ad165d7902b292d46b442ce2a4a25d5a891dd9d" as Address // VaultComposerSync on Ethereum
    },
    // Add other vaults here as needed
    usdt0: {
        asset: "0x...",  // USDT0 OFT on Base
        share: "0x...",  // sUSDT0 OFT on Base  
        composer: "0x..." // DAI VaultComposerSync on Ethereum
    }
};

// ============================================
// OVault Withdrawal (Redeem) Operation
// ============================================
function encodeShareRedeemOperationWithRuntimeBalance(
    userAddress: Address,
    shareOftAddress: Address,
    composerAddress: Address,
    totalFeeInEth: string
) {
    const totalFeeWei = parseUnits(totalFeeInEth, 18);

    // Use runtime balance for all available shares
    const runtimeBalance = {
        type: 'runtimeErc20Balance',
        tokenAddress: shareOftAddress
    };

    // Gas configuration for LayerZero
    const options = concat([
        '0x0003',                                    // TYPE_3
        '0x01',                                      // EXECUTOR_WORKER_ID
        '0x0011',                                    // option_size: 17 bytes
        '0x01',                                      // OPTION_TYPE_LZRECEIVE
        pad(numberToHex(100000), { size: 16 })      // 100k gas for basic receive
    ]);

    // Compose message to receive assets back on Base
    // When shares are sent to composer, it triggers redeem and sends assets back
    const composeMsg = encodeAbiParameters(
        parseAbiParameters('(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),uint256'),
        [[
            eidBase,                           // Return assets to Base
            pad(userAddress, { size: 32 }),   // Final recipient
            parseUnits("1", 18),              // Placeholder for asset amount (composer will update)
            1n,                               // Min assets to receive (slippage protection)
            '0x',                             // Empty extraOptions for return
            '0x',                             // Empty composeMsg for return
            '0x'                              // Empty oftCmd
        ],
            parseUnits("0.0005", 18)          // Native value for return message
        ]
    );

    return encodeBuildOperation(
        "function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress)",
        [
            [
                eidEthereum,                   // To Ethereum hub
                pad(composerAddress, { size: 32 }), // VaultComposerSync address
                runtimeBalance,                // All available shares
                1n.toString(),                 // Min shares to send
                options,                       // Gas configuration
                composeMsg,                    // Return instructions for assets
                '0x'                           // No OFT commands
            ],
            [totalFeeWei.toString(), "0"],    // Fee in wei
            userAddress                        // Refund address
        ],
        shareOftAddress,  // Send FROM share token (this triggers redeem)
        base.id,
        totalFeeWei.toString()
    );
}

// ============================================
// OVault Deposit Operation (existing, updated)
// ============================================
function encodeAssetDepositOperationWithRuntimeBalance(
    userAddress: Address,
    assetOftAddress: Address,
    composerAddress: Address,
    totalFeeInEth: string
) {
    const totalFeeWei = parseUnits(totalFeeInEth, 18);

    // Use runtime balance for all available assets
    const runtimeBalance = {
        type: 'runtimeErc20Balance',
        tokenAddress: assetOftAddress
    };

    const options = concat([
        '0x0003',
        '0x01',
        '0x0011',
        '0x01',
        pad(numberToHex(100000), { size: 16 })
    ]);

    // Compose message to receive shares back on Base
    const composeMsg = encodeAbiParameters(
        parseAbiParameters('(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),uint256'),
        [[
            eidBase,                           // Return shares to Base
            pad(userAddress, { size: 32 }),   // Final recipient
            parseUnits("1", 18),              // Placeholder for share amount
            1n,                               // Min shares to receive
            '0x',
            '0x',
            '0x'
        ],
            parseUnits("0.0005", 18)
        ]
    );

    return encodeBuildOperation(
        "function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress)",
        [
            [
                eidEthereum,
                pad(composerAddress, { size: 32 }),
                runtimeBalance,
                parseUnits('0.5', 18).toString(),
                options,
                composeMsg,
                '0x'
            ],
            [totalFeeWei.toString(), "0"],
            userAddress
        ],
        assetOftAddress,  // Send FROM asset token (this triggers deposit)
        base.id,
        totalFeeWei.toString()
    );
}

// ============================================
// Fee Calculation
// ============================================
function calculateCrossChainFee(): { totalEth: string, breakdown: object } {
    const lzMessageFee = parseUnits("0.0003", 18);
    const ethereumGasCost = parseUnits("0.009", 18);
    const returnMessageFee = parseUnits("0.0005", 18);
    
    const subtotal = lzMessageFee + ethereumGasCost;
    const buffer = subtotal / 10n; // 10% buffer
    const total = subtotal + buffer;

    return {
        totalEth: formatUnits(total, 18),
        breakdown: {
            lzMessageFee: formatUnits(lzMessageFee, 18),
            ethereumGasCost: formatUnits(ethereumGasCost, 18),
            returnMessageFee: formatUnits(returnMessageFee, 18),
            buffer: formatUnits(buffer, 18),
            total: formatUnits(total, 18)
        }
    };
}

// ============================================
// Compose Instructions Helper
// ============================================
async function composeInstructions(
    ownerAddress: Address,
    operations: any[],
    mode: "smart-account" | "eoa" | "eoa-7702" = "eoa"
) {
    const response = await fetch(meeApiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
        },
        body: JSON.stringify({
            ownerAddress,
            mode,
            composeFlows: operations
        })
    });

    return response.json();
}

// ============================================
// Main Vault Rebalancing Function
// ============================================
async function buildVaultRebalancingOperation(
    userAddress: Address,
    sourceVault: {
        asset: Address,
        share: Address,
        composer: Address
    },
    targetVault: {
        asset: Address,
        share: Address,
        composer: Address
    }
) {
    const { totalEth, breakdown } = calculateCrossChainFee();
    console.log("Fee breakdown:", breakdown);

    const operations = [
        // ============================================
        // Step 1: Withdraw from Source Vault
        // ============================================
        // Redeem all shares from source vault (receive source asset)
        encodeShareRedeemOperationWithRuntimeBalance(
            userAddress,
            sourceVault.share,
            sourceVault.composer,
            totalEth
        ),

        // ============================================
        // Step 2: Swap Source Asset → Target Asset
        // ============================================
        // Swap all received assets to target vault's asset
        {
            type: "/instructions/intent-simple",
            data: {
                srcToken: sourceVault.asset,
                dstToken: targetVault.asset,
                srcChainId: base.id,
                dstChainId: base.id,
                amount: "0",  // Will use runtime balance from withdrawal
                slippage: 0.01
            },
            batch: true  // Batch with previous operation
        },

        // ============================================
        // Step 3: Deposit to Target Vault
        // ============================================
        // Deposit all target assets into target vault
        encodeAssetDepositOperationWithRuntimeBalance(
            userAddress,
            targetVault.asset,
            targetVault.composer,
            totalEth
        )
    ];

    return composeInstructions(userAddress, operations);
}

// ============================================
// Example Usage: USR Vault → DAI Vault
// ============================================
async function main() {
    const privKey = '0xaa1bc9458b85e247eecfe383283a4a797114edcfc2b5c8417e640ce04deddc62'
    const eoa = privateKeyToAccount(privKey)
    console.log(`EOA: ${eoa.address}`)

    const walletClient = createWalletClient({
        transport: http(),
        chain: base,
        account: eoa
    })

    // Define source and target vaults
    const sourceVault = knownVaults.usr;
    const targetVault = {
        asset: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Address,  // Example: DAI on Base
        share: "0x..." as Address,  // Example: sDAI shares
        composer: "0x..." as Address  // Example: DAI vault composer
    };

    // Build the vault rebalancing operation
    const composeResponse = await buildVaultRebalancingOperation(
        eoa.address,
        sourceVault,
        targetVault
    ) as any;

    if (composeResponse.error) {
        console.error("Compose error:", composeResponse.error);
        return;
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);

    // Get quote from Biconomy
    const quoteResponse = await fetch('https://api.biconomy.io/v1/mee/quote', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
        },
        body: JSON.stringify({
            mode: 'eoa',
            ownerAddress: eoa.address,
            instructions: composeResponse.instructions,
            fundingTokens: [
                // No funding tokens needed - we're using existing vault shares
            ],
            upperBoundTimestamp: nowInSeconds + 61,
            lowerBoundTimestamp: nowInSeconds,
            // Optional: specify fee token if you want to pay gas in specific token
            // feeToken: {
            //     address: sourceVault.asset,
            //     chainId: base.id
            // }
        })
    });

    const quoteJSON = await quoteResponse.json() as any;

    if (quoteJSON.error) {
        console.error("Quote error details:", JSON.stringify(quoteJSON, null, 2));
        return;
    }

    const { payloadToSign } = quoteJSON

    // Sign the payload
    const signature = await walletClient.signTypedData({
        ...payloadToSign[0].signablePayload,
    });

    const execBody = {
        ...quoteJSON,
        payloadToSign: [{
            ...payloadToSign[0],
            signature: signature
        }]
    }

    console.log("Execution body:", JSON.stringify(execBody, null, 2))

    // Execute the transaction
    const response = await fetch('https://api.biconomy.io/v1/mee/execute', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
        },
        body: JSON.stringify(execBody)
    });

    const data = await response.json() as any;
    console.log("Execution result:", data);

    if (data.error) {
        console.error("Execution error details:", JSON.stringify(data, null, 2));
    } else {
        console.log(`✅ Vault rebalancing successful!`);
        console.log(`   Withdrew from: ${sourceVault.share}`);
        console.log(`   Deposited to: ${targetVault.share}`);
        console.log(`   Transaction: ${data.supertxHash}`);
    }
}

// Run the main function
main().catch(console.error);