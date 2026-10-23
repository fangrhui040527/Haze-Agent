# Managed AWS cluster

Create a Zetaris compute cluster in your AWS account, sign in to its Gateway and run a query.

For Docker Compose on your own computer, see [Install locally](updated_zetaris_installation_guide.md).

## Before you start

- Sign in to Zetaris Cloud Gateway and the AWS account that will own the resources.
- Use an AWS identity with permission to create and delete the supplied CloudFormation stack and its resources. Review the IAM permissions requested by the stack with your AWS administrator if needed.
- Review the AWS cost notice under **Compute > Credentials**. AWS bills these resources directly to your AWS account, separately from your Zetaris tier. The estimate depends on its stated region, date and assumptions.

AWS account setup creates networking, a storage bucket and access roles. Billable resources can incur charges from setup completion until you delete them, even when no compute cluster is running. Suspending a cluster does not remove the account setup or retained storage.

## 1. Add and verify your AWS account

1. In Zetaris Cloud Gateway, open **Compute > Credentials**. The page is titled **AWS Accounts**.
2. Click **Add AWS Account**, select **Quickstart**, enter a friendly name for the account and click **Continue**.
3. Choose **US West (N. California), `us-west-1`**, the recommended region for this guide. Review the displayed AWS cost information, then click **Launch Stack**.
4. The AWS Console opens in a new tab on **Quick create stack**, with the template and parameters filled in. Check that you are signed in to the intended AWS account and that the region and stack details match the setup.
5. Leave optional tags, IAM service role and other settings at their defaults. Review **Capabilities**. Tick the acknowledgement that CloudFormation may create IAM resources with customised names, then click **Create stack**.
   Zetaris may show "Your stack is being created" before you submit the AWS form.

6. Follow the stack's progress in CloudFormation. Wait for the stack to reach `CREATE_COMPLETE`.
7. Return to the Zetaris setup tab. **Launch Stack** automatically advances it to **Waiting for AWS**, then the callback opens **Verify AWS Account**. Wait for `CREATE_COMPLETE` before clicking **Verify**. If you remain on the region page, use **I've already launched the stack** to continue.
8. After verification succeeds, click **Done** to save the configuration.
9. Confirm that the account appears under **Compute > Credentials > Active** with status **Verified**. It is now available for cluster creation.

Keep the stack name and region with your session notes. You will need the corresponding stack during teardown. If creation or verification fails, inspect the CloudFormation events and the Zetaris verification message before continuing.

## 2. Create your compute cluster

1. Open **Compute > Clusters** and click **Create Cluster**.
2. In **AWS Account**, select the verified Quickstart account you just added.
3. Enter a **Cluster Name**. Keep this name for the deletion confirmation later.
4. Choose **Mini** for the **Spark cluster size**. This trial configuration has two nodes and four vCPUs in total.
5. Review **Networking**. For a Quickstart account, the form reads the VPC and subnets from the CloudFormation stack outputs, so you do not need to select them manually.
6. Under **Lightning Access**, enter the required **Lightning Admin Email**.
7. Review the configuration and cost information shown for your account and selected size, then click **Create Compute Cluster**.
8. Open the cluster's **Lifecycle** tab and wait for all seven provisioning stages to succeed. Continue when the cluster is **Active**.

Allow approximately **30 minutes** for provisioning. Keep the Lifecycle page open to follow progress. If a stage fails, use its displayed error and the cluster's events to resolve the failure before connecting.

## 3. Connect to the Gateway and run a query

1. Open **Compute > Clusters**, select your cluster and open **Overview**.
2. Under **Access**, open the **Sign-in URL**. This opens the Gateway for this cluster.
3. Under **Organisations** on the cluster Overview, find your organisation's administrator email and password. Use **Copy password** to copy the masked password. In the Gateway login, enter the administrator email in **USERNAME** and paste the password into **PASSWORD**, then click **Sign In**. Keep them private and out of source files, prompts and recordings you share publicly.
4. In the Gateway, open **Workbench > SQL Workspace > New Query**. Find the `NY_TAXI` sample source under **File Source & API** in the data explorer. Enter this query, then click **Execute**:

```sql
SELECT * FROM NY_TAXI.taxi_zones LIMIT 5;
```

5. Confirm that the result contains **five rows**. If `NY_TAXI` is absent, check the sample sources supplied with your deployment before continuing.

The **Access** section also supplies the cluster hostname and **JDBC endpoint**. If you connect a client or coding assistant, copy the endpoint from your own cluster and follow [Client setup](../connections/client-setup.md). Use the cluster's organisation credentials rather than the credentials from a local Docker installation.

Check the cluster's **Schedule** if you need it to remain available during your session. A scheduled suspension or the **Suspend** action pauses compute availability; it does not complete AWS cleanup.

## 4. Delete the compute cluster

1. In Zetaris Cloud Gateway, open **Compute > Clusters** and select your cluster.
2. Click **Delete**. In **Delete compute?**, read the warning and type the exact cluster name shown in the dialog, then click **Delete** to confirm.
3. Follow **Lifecycle > Termination Steps** while the status is **Terminating**. The displayed stages are **Draining nodes**, **Deleting cluster** and **Releasing resources**.
4. Allow approximately **15 minutes** for termination. Wait until all three stages succeed and the cluster status is **Deleted**. Return to **Compute > Clusters** and confirm that this cluster is no longer in the active list.

The deleted cluster detail page remains available for billing reconciliation, with lifecycle, events and configuration history preserved.

Cluster deletion terminates its EKS cluster and associated IAM roles. The confirmation dialog explicitly says that EFS and S3 are preserved. Keep any data you need before proceeding with the AWS account cleanup below.

## 5. Delete the CloudFormation stack and mark the credential deleted

Do this after the compute cluster has finished terminating. If other active clusters use the same AWS credential configuration, finish their teardown before removing that shared setup.

1. Open **Compute > Credentials** and find the AWS account used by the cluster. Click its delete icon.
2. The confirmation dialog displays the **Stack name** and **Region**. Click **Open in AWS CloudFormation** to open that exact stack in a new tab.
3. In AWS, check the account, region and stack name against the Zetaris dialog. Click **Delete stack**.
4. Read the AWS deletion warning. Leave optional **Express mode** disabled, enter the stack name when prompted and confirm **Delete stack**. AWS deletes stack resources according to their deletion policies.
5. Wait for the stack status to reach `DELETE_COMPLETE`. If it reaches `DELETE_FAILED`, inspect the stack's **Events** and resolve the reported resource issue before continuing.
6. Return to the Zetaris credential deletion dialog and click **Mark Deleted**.
7. Confirm that the credential no longer appears under **Active**. Use the **Deleted** tab to review deleted configurations.

Zetaris cannot delete this CloudFormation stack for you. You must use your own AWS identity. **Mark Deleted** records the credential's deletion in Zetaris; it does not delete AWS resources.

## 6. Retained storage and charges

The required teardown is complete when the cluster is **Deleted**, the CloudFormation stack has reached `DELETE_COMPLETE`, and the credential appears under **Deleted** in Zetaris.

EFS and S3 storage can remain after this teardown. Deleting retained storage is optional and permanently removes any data it contains. AWS may continue charging for retained storage and other billable resources.

To review your retained storage, record the **EFS ID** from the cluster **Overview**. Find the workspace bucket's physical ID under **CloudFormation > Resources > WorkspaceS3Bucket**. Review each resource in AWS before deciding whether to keep it.

## Troubleshooting

- **Lifecycle summary still says "started".** The summary can retain this wording after completion. Check the individual stages and final cluster status: all seven provisioning stages must succeed with **Active**, or all three termination stages must succeed with **Deleted**.
- **S3 Bucket is blank in Overview.** Use **CloudFormation > Resources > WorkspaceS3Bucket** to find the bucket. A `DELETE_SKIPPED` status means CloudFormation retained it. The cluster's EFS file system is separate from the Quickstart stack and must be reviewed separately.

Use the current AWS account notice and your AWS billing information for this workflow.
