import { GraphqlQueryError } from "@shopify/shopify-api";
import shopify from "./shopify.js";

const PREMIUM_PLAN = "Premium";

export default async function cancelSubscription(
  session,
  { expectedTestMode } = {}
) {
  const subscriptions = await getActiveSubscriptions(session);
  const subscriptionId = getActiveSubscriptionId(subscriptions, {
    expectedTestMode,
  });

  if (!subscriptionId) {
    throw new Error("No active Premium subscription ID found for cancellation.");
  }

  return appSubscriptionCancel(session, subscriptionId);
}

export async function getActiveSubscriptions(session) {
  const client = new shopify.api.clients.Graphql({ session });

  const currentInstallations = await client.query({
    data: RECURRING_PURCHASES_QUERY,
  });

  return (
    currentInstallations.body.data?.currentAppInstallation?.activeSubscriptions || []
  );
}

function getActiveSubscriptionId(subscriptions, { expectedTestMode } = {}) {
  const matchingSubscriptions = subscriptions.filter(
    (subscription) => subscription?.name === PREMIUM_PLAN
  );

  if (typeof expectedTestMode === "boolean") {
    const matchingModeSubscription = matchingSubscriptions.find(
      (subscription) => subscription?.test === expectedTestMode
    );

    if (matchingModeSubscription?.id) {
      return matchingModeSubscription.id;
    }

    const oppositeModeSubscription = matchingSubscriptions.find(
      (subscription) =>
        typeof subscription?.test === "boolean" &&
        subscription.test !== expectedTestMode
    );

    if (oppositeModeSubscription) {
      const expectedMode = expectedTestMode ? "TEST" : "LIVE";
      const actualMode = oppositeModeSubscription.test ? "TEST" : "LIVE";

      throw new Error(
        `An active Premium subscription was found in ${actualMode} mode, but the app is running in ${expectedMode} mode. Update SHOPIFY_BILLING_TEST_MODE so the billing mode matches before cancelling.`
      );
    }
  }

  if (matchingSubscriptions[0]?.id) {
    return matchingSubscriptions[0].id;
  }

  if (subscriptions.length > 0) {
    throw new Error(
      "Active subscriptions were found, but none matched the Premium plan."
    );
  }

  return "";
}

async function appSubscriptionCancel(session, subscriptionId) {
  const client = new shopify.api.clients.Graphql({ session });

  const mutationResponse = await client.query({
    data: {
      query: CANCEL_SUBSCRIPTION,
      variables: {
        id: subscriptionId,
      },
    },
  });

  const topLevelErrors = mutationResponse.body.errors || [];
  const userErrors =
    mutationResponse.body.data?.appSubscriptionCancel?.userErrors || [];

  if (topLevelErrors.length || userErrors.length) {
    throw new GraphqlQueryError({
      message:
        userErrors[0]?.message || "Error while cancelling subscription.",
      response: mutationResponse.body,
      headers: {},
      body: mutationResponse.body,
    });
  }

  return mutationResponse.body.data.appSubscriptionCancel.appSubscription.status;
}

const CANCEL_SUBSCRIPTION = `
mutation appSubscriptionCancel($id: ID!) {
  appSubscriptionCancel(id: $id) {
    appSubscription {
      id
      name
      status
    }
    userErrors {
      field
      message
    }
  }
}
`;

const RECURRING_PURCHASES_QUERY = `
query appSubscription {
  currentAppInstallation {
    activeSubscriptions {
      name
      id
      test
      status
    }
  }
}
`;
